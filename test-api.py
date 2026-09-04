import unittest
import json
import os
from app import app, init_db, DB_PATH

class TestIGamingPlatform(unittest.TestCase):
    def setUp(self):
        if os.path.exists(DB_PATH):
            try:
                os.remove(DB_PATH)
            except PermissionError:
                pass
        init_db()
        self.app = app.test_client()
        self.app.testing = True

    def test_full_user_flow(self):
        import uuid
        uid = uuid.uuid4().hex[:6]
        username = f"player_{uid}"
        email = f"player_{uid}@example.com"
        password = "secretpassword123"

        # 1. Teste de Cadastro
        res = self.app.post('/api/auth/register', json={
            'username': username,
            'email': email,
            'password': password
        })
        self.assertEqual(res.status_code, 201)
        data = json.loads(res.data)
        self.assertIn('token', data)
        token = data['token']
        headers = {'Authorization': f'Bearer {token}'}

        # 2. Teste de Leitura de Perfil
        res = self.app.get('/api/auth/me', headers=headers)
        self.assertEqual(res.status_code, 200)
        profile = json.loads(res.data)['user']
        self.assertEqual(profile['username'], username)
        self.assertEqual(profile['balance'], 100.0) # Bônus de boas-vindas

        # 3. Teste de Depósito PIX e Simulação de Pagamento
        res = self.app.post('/api/wallet/deposit', headers=headers, json={'amount': 50.0})
        self.assertEqual(res.status_code, 200)
        dep_data = json.loads(res.data)
        external_id = dep_data['external_id']
        self.assertIn('pix_code', dep_data)

        # Simular confirmação de pagamento via Webhook
        res = self.app.post('/api/payments/webhook', json={
            'external_id': external_id,
            'status': 'approved'
        })
        self.assertEqual(res.status_code, 200)

        # Verificar se o saldo subiu para 150.0
        res = self.app.get('/api/wallet/balance', headers=headers)
        balance = json.loads(res.data)['balance']
        self.assertEqual(balance, 150.0)

        # 4. Teste de Rodada do Jogo (Fruit Spin)
        res = self.app.post('/api/game/spin', headers=headers, json={'bet_amount': 10.0})
        self.assertEqual(res.status_code, 200)
        spin_data = json.loads(res.data)
        self.assertEqual(len(spin_data['symbols']), 3)
        self.assertIn('new_balance', spin_data)

        # 5. Teste de Histórico de Transações
        res = self.app.get('/api/wallet/history', headers=headers)
        self.assertEqual(res.status_code, 200)
        history = json.loads(res.data)['transactions']
        self.assertTrue(len(history) >= 1)

        print("\n[OK] Todos os testes automatizados da API da Plataforma de Mini-Jogos passaram com Sucesso!")

if __name__ == '__main__':
    unittest.main()
