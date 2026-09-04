# 🍀 LuckyFruit Gaming - Plataforma de Mini-Jogos & Apostas

Plataforma completa de mini-jogos estilo iGaming desenvolvida com Python Flask, SQLite, Autenticação JWT, Carteira Digital PIX e Mini-Jogo Slot Machine de Frutas.

---

## 🚀 Como Subir para o GitHub

1. Baixe/Instale o **Git** (se ainda não tiver no seu computador).
2. Abra o terminal no diretório do projeto:
   ```bash
   cd C:\Users\Administrator\.gemini\antigravity\scratch\igaming-platform
   ```
3. Inicialize o repositório Git local e faça o primeiro commit:
   ```bash
   git init
   git add .
   git commit -m "Initial commit - LuckyFruit Gaming Platform"
   ```
4. Crie um novo repositório público ou privado no **GitHub** (ex: `luckyfruit-gaming`).
5. Conecte o repositório local ao GitHub e faça o push:
   ```bash
   git remote add origin https://github.com/SEU-USUARIO/luckyfruit-gaming.git
   git branch -M main
   git push -u origin main
   ```

---

## ⚡ Como Fazer Deploy na Vercel (Gratuito)

### Opção 1: Via Painel Web da Vercel (Recomendado)

1. Acesse **[vercel.com](https://vercel.com)** e faça login com sua conta do **GitHub**.
2. Clique no botão **"Add New..."** ➔ **"Project"**.
3. Selecione o repositório **`luckyfruit-gaming`** que você subiu para o GitHub.
4. Na tela de configuração:
   - **Framework Preset:** Deixe em *Other*.
   - **Root Directory:** `./`
5. Clique em **"Deploy"**!

A Vercel lerá o arquivo `vercel.json` e o `requirements.txt` automaticamente, publicando a plataforma online com um link de produção (ex: `https://luckyfruit-gaming.vercel.app`) em menos de 1 minuto!

---

## 🛠️ Tecnologias Utilizadas

- **Backend:** Python 3.12 / Flask (Serverless Ready)
- **Frontend:** HTML5, TailwindCSS, FontAwesome, Web Audio API
- **Banco de Dados:** SQLite (com suporte automático ao diretório temporário `/tmp` na Vercel)
- **Pagamentos:** Simulador PIX integrado + Webhook para gateways reais
