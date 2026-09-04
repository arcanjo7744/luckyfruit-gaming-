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
        username = f"ninja_{uid}"
        email = f"ninja_{uid}@example.com"
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

        # 3. Teste de Início de Partida Fruit Ninja
        res = self.app.post('/api/game/ninja/start', headers=headers, json={'bet_amount': 10.0})
        self.assertEqual(res.status_code, 200)
        session_data = json.loads(res.data)
        session_id = session_data['session_id']
        self.assertEqual(session_data['new_balance'], 90.0)

        # 4. Teste de Cash Out Fruit Ninja (Ganhou 2.5x)
        res = self.app.post('/api/game/ninja/cashout', headers=headers, json={
            'session_id': session_id,
            'multiplier': 2.5,
            'fruits_cut': 12,
            'hit_bomb': False
        })
        self.assertEqual(res.status_code, 200)
        cashout_data = json.loads(res.data)
        self.assertTrue(cashout_data['is_win'])
        self.assertEqual(cashout_data['payout'], 25.0)
        self.assertEqual(cashout_data['new_balance'], 115.0)

        # 5. Teste de Histórico de Transações e Apostas
        res = self.app.get('/api/wallet/history', headers=headers)
        self.assertEqual(res.status_code, 200)

        print("\n[OK] Todos os testes automatizados da API do Fruit Ninja passaram com Sucesso!")

if __name__ == '__main__':
    unittest.main()
