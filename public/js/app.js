// ESTADO GLOBAL DO CLIENTE
let authToken = localStorage.getItem('igaming_token') || null;
let currentUser = null;
let activeDepositExternalId = null;

document.addEventListener('DOMContentLoaded', () => {
    checkAuth();
    loadLiveWins();
    setInterval(loadLiveWins, 10000); // Atualiza ganhadores a cada 10s
});

// ------------ AUTENTICAÇÃO E PERFIL ------------

async function checkAuth() {
    if (!authToken) {
        renderGuestState();
        return;
    }

    try {
        const res = await fetch('/api/auth/me', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (res.ok) {
            const data = await res.json();
            currentUser = data.user;
            renderLoggedState();
        } else {
            logout();
        }
    } catch (err) {
        console.error("Erro ao checar autenticação:", err);
        renderGuestState();
    }
}

function renderLoggedState() {
    document.getElementById('user-guest').classList.add('hidden');
    document.getElementById('user-logged').classList.remove('hidden');
    document.getElementById('user-display-name').innerText = `@${currentUser.username}`;
    updateBalanceDisplay(currentUser.balance);
}

function renderGuestState() {
    document.getElementById('user-logged').classList.add('hidden');
    document.getElementById('user-guest').classList.remove('hidden');
}

function updateBalanceDisplay(balance) {
    if (currentUser) currentUser.balance = balance;
    const formatted = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(balance);
    document.getElementById('user-balance').innerText = formatted;
}

async function handleRegister(e) {
    e.preventDefault();
    const username = document.getElementById('reg-username').value;
    const email = document.getElementById('reg-email').value;
    const password = document.getElementById('reg-password').value;

    try {
        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, email, password })
        });
        const data = await res.json();

        if (res.ok) {
            authToken = data.token;
            localStorage.setItem('igaming_token', authToken);
            currentUser = data.user;
            closeModal('register-modal');
            renderLoggedState();
            showToast('🎉 ' + data.message, 'success');
        } else {
            showToast(data.message, 'error');
        }
    } catch (err) {
        showToast('Erro ao se comunicar com o servidor.', 'error');
    }
}

async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (res.ok) {
            authToken = data.token;
            localStorage.setItem('igaming_token', authToken);
            currentUser = data.user;
            closeModal('login-modal');
            renderLoggedState();
            showToast('⚡ ' + data.message, 'success');
        } else {
            showToast(data.message, 'error');
        }
    } catch (err) {
        showToast('Erro de conexão ao realizar login.', 'error');
    }
}

function logout() {
    authToken = null;
    currentUser = null;
    localStorage.removeItem('igaming_token');
    renderGuestState();
    showToast('Você saiu da sua conta.', 'info');
}

// ------------ CARTEIRA & PIX ------------

function setDepositAmount(val) {
    document.getElementById('deposit-amount').value = val.toFixed(2);
}

async function generatePix() {
    if (!authToken) {
        openModal('login-modal');
        return;
    }
    const amount = parseFloat(document.getElementById('deposit-amount').value);

    try {
        const res = await fetch('/api/wallet/deposit', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ amount })
        });
        const data = await res.json();

        if (res.ok) {
            activeDepositExternalId = data.external_id;
            document.getElementById('pix-qr-img').src = data.qr_code_image;
            document.getElementById('pix-code-input').value = data.pix_code;

            document.getElementById('deposit-form-step').classList.add('hidden');
            document.getElementById('deposit-qr-step').classList.remove('hidden');
            showToast('PIX gerado! Faça o pagamento no seu banco.', 'success');
            watchDepositConfirmation(activeDepositExternalId);
        } else {
            showToast(data.message, 'error');
        }
    } catch (err) {
        showToast('Erro ao gerar PIX.', 'error');
    }
}

function copyPixCode() {
    const pixInput = document.getElementById('pix-code-input');
    pixInput.select();
    navigator.clipboard.writeText(pixInput.value);
    showToast('Código PIX Copia e Cola copiado!', 'info');
}

async function watchDepositConfirmation(externalId) {
    const startedAt = Date.now();
    const check = async () => {
        if (!authToken || activeDepositExternalId !== externalId || Date.now() - startedAt > 15 * 60 * 1000) return;
        try {
            const res = await fetch(`/api/payments/status/${encodeURIComponent(externalId)}`, {
                headers: { 'Authorization': `Bearer ${authToken}` }
            });
            const data = await res.json();
            if (res.ok && data.status === 'completed') {
                updateBalanceDisplay(data.balance);
                closeModal('deposit-modal');
                document.getElementById('deposit-form-step').classList.remove('hidden');
                document.getElementById('deposit-qr-step').classList.add('hidden');
                activeDepositExternalId = null;
                showToast('PIX confirmado e saldo atualizado!', 'success');
                return;
            }
        } catch (_) {
            // A próxima verificação tentará novamente.
        }
        setTimeout(check, 5000);
    };
    setTimeout(check, 4000);
}

async function handleWithdraw(e) {
    e.preventDefault();
    if (!authToken) {
        openModal('login-modal');
        return;
    }

    const pixKey = document.getElementById('withdraw-pix-key').value;
    const amount = parseFloat(document.getElementById('withdraw-amount').value);

    try {
        const res = await fetch('/api/wallet/withdraw', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ pix_key: pixKey, amount })
        });
        const data = await res.json();

        if (res.ok) {
            updateBalanceDisplay(data.new_balance);
            closeModal('withdraw-modal');
            showToast('💸 ' + data.message, 'success');
        } else {
            showToast(data.message, 'error');
        }
    } catch (err) {
        showToast('Erro ao solicitar saque.', 'error');
    }
}

async function loadHistory() {
    if (!authToken) return;

    try {
        const res = await fetch('/api/wallet/history', {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        const data = await res.json();

        const container = document.getElementById('history-list');
        container.innerHTML = '';

        if (!data.transactions || data.transactions.length === 0) {
            container.innerHTML = '<div class="text-slate-500 text-center py-4">Nenhuma transação encontrada.</div>';
            return;
        }

        data.transactions.forEach(tx => {
            const isDeposit = tx.type === 'deposit';
            const badge = isDeposit ? 'bg-emerald-950 text-emerald-400 border-emerald-800' : 'bg-pink-950 text-pink-400 border-pink-800';
            const icon = isDeposit ? '📥 Depósito' : '📤 Saque';
            
            const div = document.createElement('div');
            div.className = 'bg-slate-950 border border-slate-800 rounded-xl p-3 flex items-center justify-between';
            div.innerHTML = `
                <div>
                    <span class="font-bold border px-2 py-0.5 rounded-md text-[10px] ${badge}">${icon}</span>
                    <span class="text-slate-400 text-[11px] block mt-1">${new Date(tx.created_at).toLocaleString('pt-BR')}</span>
                </div>
                <div class="text-right font-bold text-sm ${isDeposit ? 'text-emerald-400' : 'text-slate-300'}">
                    ${isDeposit ? '+' : '-'} R$ ${tx.amount.toFixed(2)}
                </div>
            `;
            container.appendChild(div);
        });
    } catch (err) {
        console.error("Erro ao carregar histórico:", err);
    }
}

async function loadLiveWins() {
    try {
        const res = await fetch('/api/game/recent-wins');
        const data = await res.json();
        const container = document.getElementById('live-wins-list');
        container.innerHTML = '';

        if (!data.recent_wins || data.recent_wins.length === 0) {
            container.innerHTML = `
                <div class="bg-slate-950 border border-slate-800 rounded-xl p-2.5 flex items-center justify-between text-xs">
                    <span class="text-slate-300">@player_top</span>
                    <span class="text-emerald-400 font-bold">R$ 150,00</span>
                </div>
                <div class="bg-slate-950 border border-slate-800 rounded-xl p-2.5 flex items-center justify-between text-xs">
                    <span class="text-slate-300">@luck_king</span>
                    <span class="text-emerald-400 font-bold">R$ 48,00</span>
                </div>
            `;
            return;
        }

        data.recent_wins.forEach(win => {
            const div = document.createElement('div');
            div.className = 'bg-slate-950 border border-slate-800 rounded-xl p-2.5 flex items-center justify-between text-xs animate-fade-in';
            div.innerHTML = `
                <div class="flex items-center gap-2">
                    <span class="text-base">${win.symbols.split(',')[0]}</span>
                    <span class="text-slate-300 font-semibold">@${win.username}</span>
                </div>
                <span class="text-emerald-400 font-bold">R$ ${win.payout.toFixed(2)}</span>
            `;
            container.appendChild(div);
        });
    } catch (err) {
        console.error("Erro ao carregar ganhadores:", err);
    }
}

// ------------ MODAIS E TOASTS ------------

function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
    if (id === 'history-modal') loadHistory();
}

function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
    if (id === 'deposit-modal') {
        document.getElementById('deposit-form-step').classList.remove('hidden');
        document.getElementById('deposit-qr-step').classList.add('hidden');
    }
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    const msgEl = document.getElementById('toast-message');
    const iconEl = document.getElementById('toast-icon');

    msgEl.innerText = message;
    if (type === 'success') iconEl.innerText = '✅';
    else if (type === 'error') iconEl.innerText = '⚠️';
    else iconEl.innerText = 'ℹ️';

    toast.classList.remove('hidden');
    toast.classList.add('show');

    setTimeout(() => {
        toast.classList.remove('show');
        toast.classList.add('hidden');
    }, 4000);
}
