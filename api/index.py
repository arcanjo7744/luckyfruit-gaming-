import os
import sys

# Adicionar o diretório raiz ao PYTHONPATH para encontrar app.py
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import app

# Exportar a instância Flask para a Vercel
app = app
