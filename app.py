import os
import sqlite3
import hashlib
import hmac
import jwt
import datetime
import uuid
import random
import io
import base64
import qrcode
import urllib.request
import urllib.error
import urllib.parse
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
        transaction_columns = {row['name'] for row in cursor.execute("PRAGMA table_info(transactions)")}
        if 'gateway_token' not in transaction_columns:
            cursor.execute("ALTER TABLE transactions ADD COLUMN gateway_token TEXT")
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

OMEGA_PAY_BASE_URL = os.environ.get('OMEGA_PAY_BASE_URL', 'https://app.omegapayments.com.br/api').rstrip('/')
OMEGA_PAY_PUBLIC_KEY = os.environ.get('OMEGA_PAY_PUBLIC_KEY')
OMEGA_PAY_SECRET_KEY = os.environ.get('OMEGA_PAY_SECRET_KEY')

def omega_pay_ready():
    return bool(OMEGA_PAY_PUBLIC_KEY and OMEGA_PAY_SECRET_KEY)

def omega_pay_request(path, payload):
    """Executa uma chamada autenticada à API da Omega Pay."""
    url = urllib.parse.urljoin(f'{OMEGA_PAY_BASE_URL}/', path.lstrip('/'))
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'LuckyNinja-Payments/1.0',
            'x-public-key': OMEGA_PAY_PUBLIC_KEY,
            'x-secret-key': OMEGA_PAY_SECRET_KEY,
        },
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as error:
        detail = error.read().decode('utf-8', errors='replace')
        if 'application/json' in (error.headers.get('Content-Type') or ''):
            try:
                gateway_message = json.loads(detail).get('message') or json.loads(detail).get('error')
            except json.JSONDecodeError:
                gateway_message = None
            if gateway_message:
                raise RuntimeError(f'Omega Pay respondeu {error.code}: {gateway_message}') from error
        raise RuntimeError(f'Omega Pay bloqueou a solicitação ({error.code}).') from error
    except urllib.error.URLError as error:
        raise RuntimeError('Não foi possível conectar à Omega Pay.') from error

def hash_password(password):
    return hashlib.sha256(password.encode()).hexdigest()

def restore_token_user(payload):
    """Recria a conta na instância atual quando uma função serverless é iniciada.

    O SQLite da Vercel fica em /tmp e uma função nova pode não carregar o
    arquivo criado por outra função. Enquanto o banco PostgreSQL persistente
    não está conectado, o próprio token assinado traz a identidade mínima
    necessária para que um usuário recém-criado não receba "usuário não
    encontrado" ao abrir a cobrança PIX.
    """
    required = ('user_id', 'username', 'email', 'password_hash')
    if not all(payload.get(key) is not None for key in required):
        return
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM users WHERE id = ?", (payload['user_id'],))
        if not cursor.fetchone():
            cursor.execute(
                "INSERT OR IGNORE INTO users (id, username, email, password_hash, balance) VALUES (?, ?, ?, ?, ?)",
                (payload['user_id'], payload['username'], payload['email'], payload['password_hash'], TEST_STARTING_CREDITS)
            )
            conn.commit()

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
            restore_token_user(data)
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
            'username': username,
            'email': email,
            'password_hash': pwd_hash,
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
        'username': user['username'],
        'email': user['email'],
        'password_hash': user['password_hash'],
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
    if not omega_pay_ready():
        return jsonify({'message': 'A integração de pagamentos ainda não está configurada no servidor.'}), 503
    data = request.get_json() or {}
    try:
        amount = float(data.get('amount', 0))
    except (ValueError, TypeError):
        amount = 0

    if amount < 20.0:
        return jsonify({'message': 'O valor mínimo para depósito via PIX é R$ 20,00.'}), 400

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT username, email FROM users WHERE id = ?", (current_user_id,))
        user = cursor.fetchone()
    if not user:
        return jsonify({'message': 'Usuário não encontrado.'}), 404

    identifier = f'luckyninja_{uuid.uuid4().hex}'
    callback_url = os.environ.get('OMEGA_PAY_WEBHOOK_URL') or f'{request.url_root.rstrip("/")}/api/payments/webhook'
    omega_payload = {
        'identifier': identifier,
        'amount': round(amount, 2),
        'client': {'name': user['username'], 'email': user['email']},
        'callbackUrl': callback_url,
    }
    try:
        omega_data = omega_pay_request('/gateway/pix/receive', omega_payload)
    except RuntimeError as error:
        print('Erro ao criar cobrança Omega Pay:', error)
        return jsonify({'message': 'Não foi possível gerar o PIX. Verifique a configuração da Omega Pay e tente novamente.'}), 502

    transaction_data = omega_data.get('transaction', omega_data)
    pix_data = transaction_data.get('pix') or omega_data.get('pix') or {}
    external_id = str(transaction_data.get('id') or omega_data.get('id') or '')
    gateway_token = str(omega_data.get('token') or transaction_data.get('webhookToken') or '')
    pix_copia_e_cola = pix_data.get('code') or pix_data.get('copyPaste') or pix_data.get('qrCode') or ''
    qr_code_image = pix_data.get('image') or pix_data.get('qrCodeImage') or ''
    if not external_id or not gateway_token or not pix_copia_e_cola:
        print('Resposta incompleta da Omega Pay:', omega_data)
        return jsonify({'message': 'A Omega Pay retornou uma cobrança incompleta. Tente novamente.'}), 502

    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO transactions (user_id, type, amount, status, pix_code, external_id, gateway_token) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (current_user_id, 'deposit', amount, 'pending', pix_copia_e_cola, external_id, gateway_token)
        )
        conn.commit()
        tx_id = cursor.lastrowid

    return jsonify({
        'message': f'Cobrança PIX gerada! Você receberá 100% de bônus e terá rollover de {BONUS_ROLLOVER_MULTIPLIER}x sobre o bônus.',
        'transaction_id': tx_id,
        'external_id': external_id,
        'amount': amount,
        'pix_code': pix_copia_e_cola,
        'qr_code_image': qr_code_image
    })

@app.route('/api/wallet/withdraw', methods=['POST'])
@token_required
def request_withdraw(current_user_id):
    if TEST_MODE:
        return jsonify({'message': 'Saques estão desativados: créditos de teste não possuem valor monetário.'}), 403
    return jsonify({
        'message': 'Saques estão temporariamente em revisão. A rota oficial de transferências da Omega Pay ainda precisa ser configurada antes de enviar PIX reais.'
    }), 503
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

@app.route('/api/payments/status/<external_id>', methods=['GET'])
@token_required
def payment_status(current_user_id, external_id):
    with get_db() as conn:
        cursor = conn.cursor()
        cursor.execute(
            "SELECT status FROM transactions WHERE external_id = ? AND user_id = ? AND type = 'deposit'",
            (external_id, current_user_id)
        )
        tx = cursor.fetchone()
        if not tx:
            return jsonify({'message': 'Transação não encontrada'}), 404
        cursor.execute("SELECT balance FROM users WHERE id = ?", (current_user_id,))
        user = cursor.fetchone()
    return jsonify({'status': tx['status'], 'balance': user['balance'] if user else 0})

# Webhook para Receber Notificação de Pagamento do Gateway (Simulado / Produção)
@app.route('/api/payments/webhook', methods=['POST'])
def payment_webhook():
    data = request.get_json() or {}
    transaction_data = data.get('transaction') or {}
    external_id = str(transaction_data.get('id') or data.get('external_id') or data.get('id') or '')
    event = data.get('event', '')
    status = transaction_data.get('status') or data.get('status') or ''
    received_token = str(data.get('token') or '')

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

        if not tx['gateway_token'] or not received_token or not hmac.compare_digest(tx['gateway_token'], received_token):
            return jsonify({'message': 'Token do webhook inválido'}), 401

        if event == 'TRANSACTION_PAID' and status == 'COMPLETED':
            bonus = round(tx['amount'] * DEPOSIT_BONUS_RATE, 2)
            rollover = round(bonus * BONUS_ROLLOVER_MULTIPLIER, 2)
            cursor.execute("UPDATE users SET balance = balance + ?, rollover_required = rollover_required + ? WHERE id = ?", (tx['amount'] + bonus, rollover, tx['user_id']))
            cursor.execute("UPDATE transactions SET status = 'completed' WHERE id = ?", (tx['id'],))
            conn.commit()
            return jsonify({'message': f'Pagamento aprovado: R$ {tx["amount"]:.2f} + R$ {bonus:.2f} de bônus creditados. Rollover: R$ {rollover:.2f}.'}), 200

    return jsonify({'message': 'Webhook recebido'}), 200

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

# A Vercel executa o Flask por meio de uma única função Python. Esta ponte
# preserva as rotas públicas da API depois do rewrite definido em vercel.json.
@app.route('/api/index', methods=['GET', 'POST'])
def vercel_api_dispatch():
    path = (request.args.get('path') or '').strip('/')
    direct_routes = {
        'auth/register': register,
        'auth/login': login,
        'auth/me': get_current_user,
        'wallet/balance': get_balance,
        'wallet/deposit': create_deposit,
        'wallet/withdraw': request_withdraw,
        'wallet/history': transaction_history,
        'payments/webhook': payment_webhook,
        'game/ninja/start': ninja_start,
        'game/ninja/cashout': ninja_cashout,
        'game/recent-wins': recent_wins,
    }
    if path.startswith('payments/status/') and request.method == 'GET':
        return payment_status(path.rsplit('/', 1)[-1])
    route = direct_routes.get(path)
    if route:
        return route()
    return jsonify({'message': 'Rota da API não encontrada'}), 404

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

