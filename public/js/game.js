// MOTOR DO JOGO MINI-GAME (FRUIT SPIN SLOT MACHINE)

let isSpinning = false;
const SYMBOLS_POOL = ['🍓', '🍉', '🍇', '🍌', '🍊', '🍋'];

// Sintetizador de Som com Web Audio API (Sem necessidade de arquivos de áudio externos)
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playTone(freq, duration, type = 'sine') {
    try {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
    } catch (e) {
        // Ignora caso o áudio esteja bloqueado
    }
}

function playSpinSound() {
    playTone(300, 0.08, 'square');
}

function playWinSound() {
    playTone(523.25, 0.15); // C5
    setTimeout(() => playTone(659.25, 0.15), 120); // E5
    setTimeout(() => playTone(783.99, 0.3), 240);  // G5
}

function setBet(amount) {
    document.getElementById('bet-amount').value = amount.toFixed(2);
}

async function spinGame() {
    if (isSpinning) return;

    if (!authToken) {
        openModal('login-modal');
        return;
    }

    const betAmount = parseFloat(document.getElementById('bet-amount').value);
    if (isNaN(betAmount) || betAmount <= 0) {
        showToast('Informe um valor de aposta válido!', 'error');
        return;
    }

    if (currentUser && currentUser.balance < betAmount) {
        showToast('Saldo insuficiente para esta aposta! Faça um depósito via PIX.', 'error');
        openModal('deposit-modal');
        return;
    }

    isSpinning = true;
    const spinBtn = document.getElementById('spin-btn');
    spinBtn.disabled = true;
    spinBtn.classList.add('opacity-50', 'cursor-not-allowed');

    const banner = document.getElementById('game-result-banner');
    banner.innerHTML = '<span class="text-yellow-400 font-bold animate-pulse">GIRANDO... 🎰</span>';

    // Remover brilho anterior das bobinas
    document.querySelectorAll('.reel-box').forEach(el => el.classList.remove('reel-win'));

    // Iniciar Animação Visual das Bobinas
    const r1 = document.getElementById('reel1');
    const r2 = document.getElementById('reel2');
    const r3 = document.getElementById('reel3');

    let animInterval = setInterval(() => {
        r1.innerText = SYMBOLS_POOL[Math.floor(Math.random() * SYMBOLS_POOL.length)];
        r2.innerText = SYMBOLS_POOL[Math.floor(Math.random() * SYMBOLS_POOL.length)];
        r3.innerText = SYMBOLS_POOL[Math.floor(Math.random() * SYMBOLS_POOL.length)];
        playSpinSound();
    }, 80);

    try {
        // Enviar requisição de aposta para a API
        const res = await fetch('/api/game/spin', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ bet_amount: betAmount })
        });
        const data = await res.json();

        // Aguardar o tempo mínimo de animação (1.2s)
        await new Promise(r => setTimeout(r, 1200));
        clearInterval(animInterval);

        if (res.ok) {
            // Fixar os símbolos finais retornados do servidor
            r1.innerText = data.symbols[0];
            r2.innerText = data.symbols[1];
            r3.innerText = data.symbols[2];

            // Atualizar o saldo em tempo real
            updateBalanceDisplay(data.new_balance);

            if (data.is_win) {
                playWinSound();
                document.querySelectorAll('.reel-box').forEach(el => el.classList.add('reel-win'));
                banner.innerHTML = `
                    <div class="bg-emerald-950/80 border border-emerald-500 text-emerald-300 px-4 py-2 rounded-xl text-sm font-black shadow-lg animate-bounce">
                        🎉 VOCÊ GANHOU R$ ${data.payout.toFixed(2)}! (${data.multiplier}x)
                    </div>
                `;
                showToast(`🏆 Vitória! R$ ${data.payout.toFixed(2)} adicionados ao saldo!`, 'success');
                loadLiveWins();
            } else {
                banner.innerHTML = `
                    <span class="text-slate-400">Não foi desta vez! Tente novamente.</span>
                `;
            }
        } else {
            banner.innerHTML = `<span class="text-rose-400 font-bold">${data.message}</span>`;
            showToast(data.message, 'error');
        }
    } catch (err) {
        clearInterval(animInterval);
        banner.innerHTML = '<span class="text-rose-400">Erro ao processar aposta.</span>';
        showToast('Erro ao se conectar com o servidor.', 'error');
    } finally {
        isSpinning = false;
        spinBtn.disabled = false;
        spinBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
}
