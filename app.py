import os
import sqlite3
import hashlib
import jwt
import datetime
import uuid
import random
import io
import base64
import qrcode
import urllib.request
import json
from functools import wraps
from flask import Flask, request, jsonify, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, 'public')

app = Flask(__name__, static_folder=PUBLIC_DIR, static_url_path='')
SECRET_KEY = os.environ.get("JWT_SECRET", "super_secret_igaming_key_change_in_production")

# Definir caminho do banco SQLite (Suporta ambiente Serverless da Vercel salvando em /tmp)
if os.environ.get('VERCEL'):
    DB_PATH = '/tmp/database.db'
else:
    DB_PATH = os.path.join(BASE_DIR, 'database.db')

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        cursor = conn.cursor()
        # Tabela de Usuários
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                balance REAL DEFAULT 100.0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        # Controle de rollover do bônus de depósito. ALTER é necessário para
        # instalações que já possuem a tabela users criada.
        user_columns = {row['name'] for row in cursor.execute("PRAGMA table_info(users)")}
        if 'rollover_required' not in user_columns:
            cursor.execute("ALTER TABLE users ADD COLUMN rollover_required REAL DEFAULT 0")
        if 'rollover_wagered' not in user_columns:
            cursor.execute("ALTER TABLE users ADD COLUMN rollover_wagered REAL DEFAULT 0")
        # Tabela de Transações (Depósitos e Saques)
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                type TEXT NOT NULL, -- 'deposit' ou 'withdraw'
                amount REAL NOT NULL,
                status TEXT NOT NULL, -- 'pending', 'completed', 'failed'
                pix_code TEXT,
                external_id TEXT UNIQUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        ''')
        # Tabela de Apostas do Jogo
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS bets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                bet_amount REAL NOT NULL,
                payout REAL NOT NULL,
                win INTEGER NOT NULL, -- 1 ou 0
                symbols TEXT NOT NULL,
                multiplier REAL NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        ''')
        conn.commit()

# Inicializa o banco no carregamento
init_db()

# Sessões ativas de partidas do Fruit Ninja
ACTIVE_SESSIONS = {}
TEST_MODE = False
TEST_STARTING_CREDITS = 100.0
DEPOSIT_BONUS_RATE = 1.0
BONUS_ROLLOVER_MULTIPLIER = 5

def hash_password(password):
    return hashlib.sha256(password.encode()).hexdigest()

def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        if 'Authorization' in request.headers:
            auth_header = request.headers['Authorization']
            if auth_header.startswith('Bearer '):
                token = auth_header.split(' ')[1]
        if not token:
            return jsonify({'message': 'Token de autenticação ausente!'}), 401
        try:
            data = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
            current_user_id = data['user_id']
        except Exception:
            return jsonify({'message': 'Token inválido ou expirado!'}), 401
        return f(current_user_id, *args, **kwargs)
    return decorated

# ----------------- ROTAS DE AUTENTICAÇÃO -----------------

@app.route('/api/auth/register', methods=['POST'])
def register():
    data = request.get_json() or {}
    username = data.get('username', '').strip()
    email = data.get('email', '').strip().lower()
    password = data.get('password', '')

    if not username or not email or not password:
        return jsonify({'message': 'Preencha todos os campos obrigatórios!'}), 400

    pwd_hash = hash_password(password)
    try:
        with get_db() as conn:
            cursor = conn.cursor()
            cursor.execute(
                "INSERT INTO users (username, email, password_hash, balance) VALUES (?, ?, ?, ?)",
                (username, email, pwd_hash, TEST_STARTING_CREDITS)
            )
            conn.commit()
            user_id = cursor.lastrowid

        token = jwt.encode({
            'user_id': user_id,
            'exp': datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=7)
        }, SECRET_KEY, algorithm="HS256")

        return jsonify({
            'message': 'Conta criada com sucesso! Bônus inicial de R$ 100,00 concedido.',
            'token': token,
            'user': {'id': user_id, 'username': username, 'email': email, 'balance': TEST_STARTING_CREDITS}
        }), 201
    except sqlite3.IntegrityError:
        return jsonify({'message': 'Usuário ou e-mail já cadastrado!'}), 400

@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.get_json() or {}
    username_or_email = data.get('username', '').strip().lower()
    password = data.get('password', '')

    pwd_hash = hash_password(password)
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM users WHERE lower(username) = ? OR lower(email) = ?",
            (username_or_email, username_or_email)
        )
        user = cursor.fetchone()

    if not user or user['password_hash'] != pwd_hash:
        return jsonify({'message': 'Usuário ou senha incorretos!'}), 401

    token = jwt.encode({
        'user_id': user['id'],
        'exp': datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=7)
    }, SECRET_KEY, algorithm="HS256")

    return jsonify({
        'message': 'Login realizado com sucesso!',
        'token': token,
        'user': {
            'id': user['id'],
            'username': user['username'],
            'email': user['email'],
            'balance': user['balance']
        }
    })

@app.route('/api/auth/me', methods=['GET'])
@token_required
def get_current_user(current_user_id):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id, username, email, balance, rollover_required, rollover_wagered FROM users WHERE id = ?", (current_user_id,))
        user = cursor.fetchone()

    if not user:
        return jsonify({'message': 'Usuário não encontrado!'}), 404

    return jsonify({'user': dict(user)})

# ----------------- ROTAS DE CARTEIRA & PIX -----------------

@app.route('/api/wallet/balance', methods=['GET'])
@token_required
def get_balance(current_user_id):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT balance, rollover_required, rollover_wagered FROM users WHERE id = ?", (current_user_id,))
        user = cursor.fetchone()

    if not user:
        return jsonify({'balance': 0.0, 'rollover_remaining': 0.0})
    return jsonify({
        'balance': user['balance'],
        'rollover_remaining': round(max(0, user['rollover_required'] - user['rollover_wagered']), 2)
    })

@app.route('/api/wallet/deposit', methods=['POST'])
@token_required
def create_deposit(current_user_id):
    if TEST_MODE:
        return jsonify({'message': 'Depósitos estão desativados: esta é uma versão de teste com créditos fictícios.'}), 403
    data = request.get_json() or {}
    try:
        amount = float(data.get('amount', 0))
    except (ValueError, TypeError):
        amount = 0

    if amount < 5.0:
        return jsonify({'message': 'O valor mínimo para depósito via PIX é R$ 5,00.'}), 400

    mp_access_token = os.environ.get('MERCADOPAGO_ACCESS_TOKEN')
    
    # Se houver chave do Mercado Pago configurada nas variáveis de ambiente
    if mp_access_token:
        try:
            mp_url = "https://api.mercadopago.com/v1/payments"
            mp_data = {
                "transaction_amount": amount,
                "description": "Deposito LuckyFruit Gaming",
                "payment_method_id": "pix",
                "payer": { "email": "pagador@luckyfruitgaming.com" }
            }
            req = urllib.request.Request(
                mp_url,
                data=json.dumps(mp_data).encode('utf-8'),
                headers={
                    "Authorization": f"Bearer {mp_access_token}",
                    "Content-Type": "application/json"
                }
            )
            with urllib.request.urlopen(req) as response:
                res_data = json.loads(response.read().decode())
                pix_copia_e_cola = res_data['point_of_interaction']['transaction_data']['qr_code']
                qr_code_base64 = "data:image/png;base64," + res_data['point_of_interaction']['transaction_data']['qr_code_base64']
                external_id = str(res_data['id'])
        except Exception as e:
            print("Erro ao integrar com Mercado Pago:", e)
            mp_access_token = None

    # Fallback para o Motor de PIX Simulado de Produção/Teste
    if not mp_access_token:
        external_id = f"pix_{uuid.uuid4().hex[:12]}"
        pix_copia_e_cola = f"00020126580014BR.GOV.BCB.PIX0136{uuid.uuid4()}5204000053039865405{amount:.2f}5802BR5916LUCKYFRUIT GAMING6009SAO PAULO62070503***6304ABCD"

        # Gerar imagem QR Code em Base64
        qr = qrcode.QRCode(version=1, box_size=6, border=2)
        qr.add_data(pix_copia_e_cola)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        
        buffered = io.BytesIO()
        img.save(buffered, format="PNG")
        qr_code_base64 = "data:image/png;base64," + base64.b64encode(buffered.getvalue()).decode('utf-8')

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO transactions (user_id, type, amount, status, pix_code, external_id) VALUES (?, ?, ?, ?, ?, ?)",
            (current_user_id, 'deposit', amount, 'pending', pix_copia_e_cola, external_id)
        )
        conn.commit()
        tx_id = cursor.lastrowid

    return jsonify({
        'message': f'Cobrança PIX gerada! Você receberá 100% de bônus e terá rollover de {BONUS_ROLLOVER_MULTIPLIER}x sobre o bônus.',
        'transaction_id': tx_id,
        'external_id': external_id,
        'amount': amount,
        'pix_code': pix_copia_e_cola,
        'qr_code_image': qr_code_base64
    })

@app.route('/api/wallet/withdraw', methods=['POST'])
@token_required
def request_withdraw(current_user_id):
    if TEST_MODE:
        return jsonify({'message': 'Saques estão desativados: créditos de teste não possuem valor monetário.'}), 403
    data = request.get_json() or {}
    try:
        amount = float(data.get('amount', 0))
    except (ValueError, TypeError):
        amount = 0

    pix_key = data.get('pix_key', '').strip()
    if not pix_key:
        return jsonify({'message': 'Informe uma chave PIX válida!'}), 400

    if amount < 150.0:
        return jsonify({'message': 'O valor mínimo para saque é R$ 150,00.'}), 400

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT balance, rollover_required, rollover_wagered FROM users WHERE id = ?", (current_user_id,))
        user = cursor.fetchone()

        if not user:
            return jsonify({'message': 'Usuário não encontrado!'}), 404

        rollover_remaining = round(max(0, user['rollover_required'] - user['rollover_wagered']), 2)
        if rollover_remaining > 0:
            return jsonify({'message': f'Complete o rollover do bônus antes de sacar. Falta apostar R$ {rollover_remaining:.2f}.'}), 400

        if user['balance'] < amount:
            return jsonify({'message': 'Saldo insuficiente para realizar este saque!'}), 400

        # Debitar valor e registrar saque
        new_balance = round(user['balance'] - amount, 2)
        cursor.execute("UPDATE users SET balance = ? WHERE id = ?", (new_balance, current_user_id))
        
        external_id = f"wdr_{uuid.uuid4().hex[:12]}"
        cursor.execute(
            "INSERT INTO transactions (user_id, type, amount, status, pix_code, external_id) VALUES (?, ?, ?, ?, ?, ?)",
            (current_user_id, 'withdraw', amount, 'completed', f"Chave PIX: {pix_key}", external_id)
        )
        conn.commit()

    return jsonify({
        'message': f'Saque de R$ {amount:.2f} processado com sucesso para a chave PIX informada!',
        'new_balance': new_balance
    })

@app.route('/api/wallet/history', methods=['GET'])
@token_required
def transaction_history(current_user_id):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT id, type, amount, status, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
            (current_user_id,)
        )
        txs = [dict(row) for row in cursor.fetchall()]

    return jsonify({'transactions': txs})

# Webhook para Receber Notificação de Pagamento do Gateway (Simulado / Produção)
@app.route('/api/payments/webhook', methods=['POST'])
def payment_webhook():
    data = request.get_json() or {}
    external_id = data.get('external_id') or str(data.get('id', ''))
    status = data.get('status') or data.get('action', '')

    if not external_id:
        return jsonify({'message': 'ID de transação não informado'}), 400

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM transactions WHERE external_id = ?", (external_id,))
        tx = cursor.fetchone()

        if not tx:
            return jsonify({'message': 'Transação não encontrada'}), 404

        if tx['status'] == 'completed':
            return jsonify({'message': 'Transação já foi creditada'}), 200

        if status in ['approved', 'completed', 'paid', 'payment.updated']:
            bonus = round(tx['amount'] * DEPOSIT_BONUS_RATE, 2)
            rollover = round(bonus * BONUS_ROLLOVER_MULTIPLIER, 2)
            cursor.execute("UPDATE users SET balance = balance + ?, rollover_required = rollover_required + ? WHERE id = ?", (tx['amount'] + bonus, rollover, tx['user_id']))
            cursor.execute("UPDATE transactions SET status = 'completed' WHERE id = ?", (tx['id'],))
            conn.commit()
            return jsonify({'message': f'Pagamento aprovado: R$ {tx["amount"]:.2f} + R$ {bonus:.2f} de bônus creditados. Rollover: R$ {rollover:.2f}.'}), 200

    return jsonify({'message': 'Webhook recebido'}), 200

# Botão de Teste no Frontend para Simular Pagamento Instantâneo do PIX
@app.route('/api/payments/simulate-pay', methods=['POST'])
@token_required
def simulate_pay(current_user_id):
    data = request.get_json() or {}
    external_id = data.get('external_id')

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM transactions WHERE external_id = ? AND user_id = ?", (external_id, current_user_id))
        tx = cursor.fetchone()

        if not tx:
            return jsonify({'message': 'Transação não encontrada!'}), 404

        if tx['status'] == 'completed':
            return jsonify({'message': 'Este PIX já foi pago anteriormente.'}), 400

        # Creditar depósito + bônus de 100% e registrar rollover do bônus.
        bonus = round(tx['amount'] * DEPOSIT_BONUS_RATE, 2)
        rollover = round(bonus * BONUS_ROLLOVER_MULTIPLIER, 2)
        cursor.execute("UPDATE users SET balance = balance + ?, rollover_required = rollover_required + ? WHERE id = ?", (tx['amount'] + bonus, rollover, current_user_id))
        cursor.execute("UPDATE transactions SET status = 'completed' WHERE id = ?", (tx['id'],))
        
        cursor.execute("SELECT balance FROM users WHERE id = ?", (current_user_id,))
        new_balance = cursor.fetchone()['balance']
        conn.commit()

        return jsonify({
            'message': f'PIX de R$ {tx["amount"]:.2f} confirmado + R$ {bonus:.2f} de bônus! Rollover pendente: R$ {rollover:.2f}.',
            'new_balance': new_balance,
            'bonus': bonus,
            'rollover_remaining': rollover
        })

# ----------------- MOTOR DO JOGO FRUIT NINJA APOSTAS -----------------

NINJA_REWARD_RATES = (0.025, 0.040, 0.060, 0.085, 0.110)
NINJA_FRUITS_PER_LEVEL = 5
NINJA_MAX_FRUITS = 40
NINJA_MIN_CASHOUT_MULTIPLIER = 4.0


def ninja_expected_multiplier(fruits_cut):
    """Calcula a escada de recompensa usada pelo cliente e validada no cash out."""
    if fruits_cut < 1 or fruits_cut > NINJA_MAX_FRUITS:
        raise ValueError('Quantidade de frutas fora do limite permitido.')

    multiplier = 1.0
    for fruit_number in range(1, fruits_cut + 1):
        tier = min((fruit_number - 1) // NINJA_FRUITS_PER_LEVEL, len(NINJA_REWARD_RATES) - 1)
        multiplier += NINJA_REWARD_RATES[tier]
    return round(multiplier, 4)

@app.route('/api/game/ninja/start', methods=['POST'])
@token_required
def ninja_start(current_user_id):
    data = request.get_json() or {}
    try:
        bet_amount = float(data.get('bet_amount', 0))
    except (ValueError, TypeError):
        bet_amount = 0

    if bet_amount <= 0:
        return jsonify({'message': 'Informe um valor de aposta válido!'}), 400

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT username, balance FROM users WHERE id = ?", (current_user_id,))
        user = cursor.fetchone()

        if not user or user['balance'] < bet_amount:
            return jsonify({'message': 'Saldo insuficiente para iniciar esta partida!'}), 400

        # Debitar o valor da aposta
        new_balance = round(user['balance'] - bet_amount, 2)
        cursor.execute(
            "UPDATE users SET balance = ?, rollover_wagered = MIN(rollover_required, rollover_wagered + ?) WHERE id = ?",
            (new_balance, bet_amount, current_user_id)
        )
        conn.commit()

        session_id = uuid.uuid4().hex
        ACTIVE_SESSIONS[session_id] = {
            'user_id': current_user_id,
            'username': user['username'],
            'bet_amount': bet_amount,
            'started_at': datetime.datetime.now(datetime.timezone.utc)
        }

    return jsonify({
        'session_id': session_id,
        'bet_amount': bet_amount,
        'new_balance': new_balance,
        'message': 'Partida iniciada! Fatie as frutas e evite as bombas.'
    })

@app.route('/api/game/ninja/cashout', methods=['POST'])
@token_required
def ninja_cashout(current_user_id):
    data = request.get_json() or {}
    session_id = data.get('session_id')
    try:
        multiplier = float(data.get('multiplier', 1.0))
        fruits_cut = int(data.get('fruits_cut', 0))
        hit_bomb = bool(data.get('hit_bomb', False))
    except (ValueError, TypeError):
        return jsonify({'message': 'Dados de partida inválidos!'}), 400

    session = ACTIVE_SESSIONS.get(session_id)
    if not session or session['user_id'] != current_user_id:
        return jsonify({'message': 'Sessão de jogo expirada ou inválida!'}), 400

    if not hit_bomb:
        try:
            expected_multiplier = ninja_expected_multiplier(fruits_cut)
        except ValueError as error:
            return jsonify({'message': str(error)}), 400

        if abs(multiplier - expected_multiplier) > 0.0001:
            return jsonify({'message': 'Multiplicador inválido para a sequência informada.'}), 400

        if expected_multiplier < NINJA_MIN_CASHOUT_MULTIPLIER:
            return jsonify({'message': 'O Cash Out só é liberado ao atingir 4,00x da aposta.'}), 400

    ACTIVE_SESSIONS.pop(session_id, None)

    bet_amount = session['bet_amount']
    payout = 0.0
    is_win = False

    if not hit_bomb and multiplier > 1.0:
        is_win = True
        payout = round(bet_amount * multiplier, 2)

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT balance, username FROM users WHERE id = ?", (current_user_id,))
        user = cursor.fetchone()

        new_balance = round(user['balance'] + payout, 2)
        cursor.execute("UPDATE users SET balance = ? WHERE id = ?", (new_balance, current_user_id))

        # Registrar no histórico de apostas
        cursor.execute(
            "INSERT INTO bets (user_id, username, bet_amount, payout, win, symbols, multiplier) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (current_user_id, user['username'], bet_amount, payout, 1 if is_win else 0, f"🔪 {fruits_cut} Frutas", multiplier if is_win else 0.0)
        )
        conn.commit()

    return jsonify({
        'is_win': is_win,
        'payout': payout,
        'multiplier': multiplier if is_win else 0.0,
        'new_balance': new_balance,
        'message': f'Cash Out realizado! Você ganhou R$ {payout:.2f}' if is_win else 'Você acertou uma bomba! Aposta perdida.'
    })

@app.route('/api/game/recent-wins', methods=['GET'])
def recent_wins():
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT username, payout, bet_amount, symbols FROM bets WHERE win = 1 ORDER BY created_at DESC LIMIT 10"
        )
        wins = [dict(row) for row in cursor.fetchall()]
    return jsonify({'recent_wins': wins})

# ----------------- SERVIR ARQUIVOS ESTÁTICOS NA VERCEL & LOCAL -----------------

@app.route('/')
def index():
    if request.args.get('view') == 'arena':
        return send_from_directory(PUBLIC_DIR, 'index.html')
    return send_from_directory(PUBLIC_DIR, 'landing.html')

@app.route('/arena')
def arena():
    return send_from_directory(PUBLIC_DIR, 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    # Vercel forwards public requests to this internal function path. Use the
    # query to switch views so the public root can stay the landing page.
    if path == 'api/index':
        if request.args.get('view') == 'arena':
            return send_from_directory(PUBLIC_DIR, 'index.html')
        return send_from_directory(PUBLIC_DIR, 'landing.html')

    target_path = os.path.join(PUBLIC_DIR, path)
    if os.path.exists(target_path):
        return send_from_directory(PUBLIC_DIR, path)
    return send_from_directory(PUBLIC_DIR, 'index.html')

if __name__ == '__main__':
    print("Servidor LuckyFruit Gaming rodando na porta 3000 (http://localhost:3000)")
    app.run(host='0.0.0.0', port=3000, debug=True)
