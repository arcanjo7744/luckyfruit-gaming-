// MOTOR GRÁFICO & FÍSICA DO JOGO FRUIT NINJA (DIFICULDADE A CADA FRUTA & GANHOS EXPONENCIAIS POR HABILIDADE)

let gameState = 'IDLE'; // 'IDLE', 'PLAYING', 'GAMEOVER'
let currentSessionId = null;
let currentBetAmount = 25.0;
let fruitsCutCount = 0;
let missedFruitCount = 0;
let currentMultiplier = 1.0;
let currentWinAmount = 25.0;

let currentLevel = 1;
let levelUpNotice = null; // Banner flutuante no Canvas

// Cinco faixas: o início é controlado, mas as sequências longas recompensam
// precisão e reflexo. Cada faixa dura cinco frutas.
const REWARD_RATES = [0.025, 0.040, 0.060, 0.085, 0.110];
const FRUITS_PER_LEVEL = 5;
const MIN_CASHOUT_MULTIPLIER = 4.0;

function getRewardRate(fruitsCut) {
    const tier = Math.min(
        REWARD_RATES.length - 1,
        Math.floor(Math.max(0, fruitsCut - 1) / FRUITS_PER_LEVEL)
    );
    return REWARD_RATES[tier];
}

function getLevelForFruitCount(fruitsCut) {
    return Math.floor(Math.max(0, fruitsCut) / FRUITS_PER_LEVEL) + 1;
}

const canvas = document.getElementById('ninja-canvas');
const ctx = canvas.getContext('2d');

// Ajustar resolução interna do Canvas
function resizeCanvas() {
    canvas.width = canvas.clientWidth || 800;
    canvas.height = canvas.clientHeight || 500;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// EFEITOS SONOROS COM WEB AUDIO API
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
    } catch (e) {}
}

function playSliceSound() {
    playTone(650, 0.05, 'triangle');
    setTimeout(() => playTone(1300, 0.04, 'sine'), 30);
}

function playLevelUpSound() {
    playTone(440, 0.1, 'sine');
    setTimeout(() => playTone(554.37, 0.1, 'sine'), 80);
    setTimeout(() => playTone(659.25, 0.1, 'sine'), 160);
    setTimeout(() => playTone(880.00, 0.25, 'triangle'), 240);
}

function playBombExplodeSound() {
    try {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(120, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(20, audioCtx.currentTime + 0.5);
        gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.5);
    } catch (e) {}
}

function playCashoutSound() {
    playTone(523.25, 0.12);
    setTimeout(() => playTone(659.25, 0.12), 100);
    setTimeout(() => playTone(783.99, 0.25), 200);
}

// ARRAYS DE OBJETOS EM CENA
let objects = [];
let particles = [];
let splatters = [];
let floatingTexts = [];
let bladeTrail = [];

const FRUIT_TYPES = [
    { name: 'Morango', icon: '🍓', color: '#EF4444' },
    { name: 'Melancia', icon: '🍉', color: '#10B981' },
    { name: 'Uva', icon: '🍇', color: '#8B5CF6' },
    { name: 'Banana', icon: '🍌', color: '#F59E0B' },
    { name: 'Laranja', icon: '🍊', color: '#F97316' },
    { name: 'Limão', icon: '🍋', color: '#84CC16' },
    { name: 'Abacaxi', icon: '🍍', color: '#EAB308' },
    { name: 'Coco', icon: '🥥', color: '#A1A1AA' }
];

class GameObject {
    constructor(isBomb = false, fruitsCut = 0) {
        this.isBomb = isBomb;
        this.radius = isBomb ? 26 : 30;
        this.x = Math.random() * (canvas.width - 120) + 60;
        this.y = canvas.height + 40;
        
        // Cada corte aumenta a velocidade; sequências longas exigem reflexos reais.
        const speedBoost = Math.min(2.45, 1.0 + (fruitsCut * 0.055));
        
        const targetX = canvas.width / 2 + (Math.random() - 0.5) * 380;
        this.vx = ((targetX - this.x) / 42) * speedBoost;
        this.vy = -(Math.random() * 4.5 + 13.5) * speedBoost;
        this.gravity = 0.37 * speedBoost;
        
        this.rotation = Math.random() * Math.PI * 2;
        this.vRot = (Math.random() - 0.5) * (0.16 * speedBoost);
        
        this.sliced = false;
        
        if (!isBomb) {
            const fruitData = FRUIT_TYPES[Math.floor(Math.random() * FRUIT_TYPES.length)];
            this.icon = fruitData.icon;
            this.color = fruitData.color;
        } else {
            this.icon = '💣';
            this.color = '#EF4444';
        }
    }

    update() {
        this.x += this.vx;
        this.y += this.vy;
        this.vy += this.gravity;
        this.rotation += this.vRot;
    }

    draw(ctx) {
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.rotation);
        
        ctx.shadowColor = this.isBomb ? 'rgba(239, 68, 68, 0.9)' : 'rgba(0, 0, 0, 0.4)';
        ctx.shadowBlur = this.isBomb ? 20 : 8;

        ctx.font = `${this.radius * 1.8}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(this.icon, 0, 0);

        ctx.restore();
    }
}

// PARTÍCULAS E SUCO DE FRUTAS
class Particle {
    constructor(x, y, color, isExplosion = false) {
        this.x = x;
        this.y = y;
        this.color = color;
        this.radius = isExplosion ? Math.random() * 6 + 3 : Math.random() * 4 + 2;
        this.vx = (Math.random() - 0.5) * (isExplosion ? 14 : 8);
        this.vy = (Math.random() - 0.5) * (isExplosion ? 14 : 8);
        this.alpha = 1.0;
        this.decay = Math.random() * 0.03 + 0.015;
        this.gravity = isExplosion ? 0.1 : 0.2;
    }

    update() {
        this.x += this.vx;
        this.y += this.vy;
        this.vy += this.gravity;
        this.alpha -= this.decay;
    }

    draw(ctx) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, this.alpha);
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

class Splatter {
    constructor(x, y, color) {
        this.x = x;
        this.y = y;
        this.color = color;
        this.radius = Math.random() * 25 + 15;
        this.alpha = 0.5;
    }

    draw(ctx) {
        ctx.save();
        ctx.globalAlpha = this.alpha;
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

// TEXTO FLUTUANTE DE GANHO (+3% / R$) NO CORTE
class FloatingText {
    constructor(x, y, text, color = '#A3E635') {
        this.x = x;
        this.y = y;
        this.text = text;
        this.color = color;
        this.vy = -1.8;
        this.alpha = 1.0;
    }

    update() {
        this.y += this.vy;
        this.alpha -= 0.022;
    }

    draw(ctx) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, this.alpha);
        ctx.font = '900 16px Poppins, sans-serif';
        ctx.fillStyle = this.color;
        ctx.shadowColor = '#84CC16';
        ctx.shadowBlur = 10;
        ctx.fillText(this.text, this.x, this.y);
        ctx.restore();
    }
}

// CONTROLE DE MOUSE E TOQUE (RASTRO DE LÂMINA)
let isSwiping = false;

function addBladePoint(x, y) {
    bladeTrail.push({ x, y, time: Date.now() });
    if (bladeTrail.length > 12) bladeTrail.shift();
    checkIntersections(x, y);
}

function getCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
        x: (clientX - rect.left) * (canvas.width / rect.width),
        y: (clientY - rect.top) * (canvas.height / rect.height)
    };
}

canvas.addEventListener('mousedown', (e) => {
    isSwiping = true;
    const pos = getCanvasCoords(e);
    addBladePoint(pos.x, pos.y);
});

canvas.addEventListener('mousemove', (e) => {
    if (!isSwiping) return;
    const pos = getCanvasCoords(e);
    addBladePoint(pos.x, pos.y);
});

window.addEventListener('mouseup', () => { isSwiping = false; });

canvas.addEventListener('touchstart', (e) => {
    isSwiping = true;
    const pos = getCanvasCoords(e);
    addBladePoint(pos.x, pos.y);
}, { passive: true });

canvas.addEventListener('touchmove', (e) => {
    if (!isSwiping) return;
    const pos = getCanvasCoords(e);
    addBladePoint(pos.x, pos.y);
}, { passive: true });

window.addEventListener('touchend', () => { isSwiping = false; });

// CHECAGEM DE COLISÃO DO CORTE
function checkIntersections(x, y) {
    if (bladeTrail.length < 2) return;

    for (let i = objects.length - 1; i >= 0; i--) {
        const obj = objects[i];
        if (obj.sliced) continue;

        const dist = Math.hypot(obj.x - x, obj.y - y);
        if (dist < obj.radius + 15) {
            obj.sliced = true;
            
            if (obj.isBomb) {
                // BOMBA CORRIDA: EXPLOSÃO E FIM DE PARTIDA
                playBombExplodeSound();
                createExplosion(obj.x, obj.y);
                triggerGameOver();
            } else {
                // FRUTA FATIADA
                playSliceSound();
                fruitsCutCount++;

                // Recompensa progressiva: +2,5%, +4%, +6%, +8,5% e +11% por fruta.
                // Os maiores valores só chegam nas faixas de risco mais alto.
                const percentGain = getRewardRate(fruitsCutCount);
                
                currentMultiplier = roundVal(currentMultiplier + percentGain, 4);
                currentWinAmount = roundVal(currentBetAmount * currentMultiplier, 2);

                const singleFruitMoney = roundVal(currentBetAmount * percentGain, 2);
                
                // Exibir valor de ganho chamativo flutuante no corte
                floatingTexts.push(new FloatingText(obj.x, obj.y, `+${(percentGain * 100).toFixed(1)}% (+R$ ${singleFruitMoney.toFixed(2)})`));

                // CHECAR SUBIDA DE NÍVEL (A CADA 5 FRUTAS)
                const newLevel = getLevelForFruitCount(fruitsCutCount);
                if (newLevel > currentLevel) {
                    currentLevel = newLevel;
                    playLevelUpSound();
                    levelUpNotice = {
                        text: `🔥 NÍVEL ${currentLevel}! MAIS VELOCIDADE | +${(getRewardRate(fruitsCutCount) * 100).toFixed(1)}%/FRUTA!`,
                        alpha: 1.0
                    };
                    showToast(`⚡ Nível ${currentLevel}! Frutas mais rápidas e com maiores recompensas!`, 'warning');
                }

                updateHUD();
                createJuiceSplatter(obj.x, obj.y, obj.color);
            }
            
            objects.splice(i, 1);
        }
    }
}

function roundVal(val, decimals = 2) {
    return Number(Math.round(val + 'e' + decimals) + 'e-' + decimals);
}

function createJuiceSplatter(x, y, color) {
    splatters.push(new Splatter(x, y, color));
    if (splatters.length > 15) splatters.shift();

    for (let i = 0; i < 12; i++) {
        particles.push(new Particle(x, y, color));
    }
}

function createExplosion(x, y) {
    for (let i = 0; i < 35; i++) {
        particles.push(new Particle(x, y, '#EF4444', true));
        particles.push(new Particle(x, y, '#F59E0B', true));
    }
}

// LOOP PRINCIPAL DE RENDERIZAÇÃO (60 FPS)
let lastSpawnTime = 0;

function gameLoop(timestamp) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Desenhar fundo de respingos
    splatters.forEach(s => s.draw(ctx));

    // Spawning Dinâmico com Dificuldade RAMP-UP por Fruta Cortada
    if (gameState === 'PLAYING') {
        // Menos tempo para reagir a cada fruta: não há ganho fácil em streaks altos.
        const spawnInterval = Math.max(330, 1150 - fruitsCutCount * 30);

        if (timestamp - lastSpawnTime > spawnInterval) {
            lastSpawnTime = timestamp;
            
            const spawnCount = fruitsCutCount > 10 ? (Math.random() < 0.60 ? 3 : 2) : (Math.random() < 0.55 ? 1 : 2);
            // Bombas e combos surgem com mais frequência conforme o prêmio aumenta.
            const bombChance = Math.min(0.62, 0.16 + fruitsCutCount * 0.021);

            for (let i = 0; i < spawnCount; i++) {
                const isBomb = Math.random() < bombChance;
                objects.push(new GameObject(isBomb, fruitsCutCount));
            }
        }
    } else if (gameState === 'IDLE') {
        if (timestamp - lastSpawnTime > 2500) {
            lastSpawnTime = timestamp;
            objects.push(new GameObject(false, 0));
        }
    }

    // Atualizar e desenhar objetos voador
    for (let i = objects.length - 1; i >= 0; i--) {
        const obj = objects[i];
        obj.update();
        obj.draw(ctx);
        if (obj.y > canvas.height + 60) {
            // Frutas ignoradas também exigem atenção: cinco escapes encerram a rodada.
            if (gameState === 'PLAYING' && !obj.isBomb && !obj.sliced) {
                missedFruitCount++;
                updateHUD();

                if (missedFruitCount >= 5) {
                    objects.splice(i, 1);
                    triggerGameOver('missed');
                    break;
                }
            }
            objects.splice(i, 1);
        }
    }

    // Atualizar e desenhar partículas
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.update();
        p.draw(ctx);
        if (p.alpha <= 0) particles.splice(i, 1);
    }

    // Atualizar e desenhar textos flutuantes (+3.0%)
    for (let i = floatingTexts.length - 1; i >= 0; i--) {
        const ft = floatingTexts[i];
        ft.update();
        ft.draw(ctx);
        if (ft.alpha <= 0) floatingTexts.splice(i, 1);
    }

    // Rastro de Lâmina Neon
    const now = Date.now();
    bladeTrail = bladeTrail.filter(p => now - p.time < 200);

    if (bladeTrail.length > 1) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(bladeTrail[0].x, bladeTrail[0].y);
        for (let i = 1; i < bladeTrail.length; i++) {
            ctx.lineTo(bladeTrail[i].x, bladeTrail[i].y);
        }
        ctx.strokeStyle = '#A3E635';
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.shadowColor = '#84CC16';
        ctx.shadowBlur = 14;
        ctx.stroke();
        ctx.restore();
    }

    // RENDERIZAR BANNER DE LEVEL UP FLUTUANTE
    if (levelUpNotice) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, levelUpNotice.alpha);
        ctx.font = '900 17px Poppins, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#A3E635';
        ctx.shadowColor = '#84CC16';
        ctx.shadowBlur = 15;
        ctx.fillText(levelUpNotice.text, canvas.width / 2, 50);
        ctx.restore();

        levelUpNotice.alpha -= 0.012;
        if (levelUpNotice.alpha <= 0) levelUpNotice = null;
    }

    requestAnimationFrame(gameLoop);
}

requestAnimationFrame(gameLoop);

// ------------ CONTROLES E INTEGRAÇÃO DE APOSTAS ------------

function setBet(amount) {
    if (gameState === 'PLAYING') return;
    currentBetAmount = amount;
    document.getElementById('bet-amount').value = amount.toFixed(2);
    updateHUD();
}

function updateHUD() {
    document.getElementById('hud-fruits-cut').innerText = `🍓 ${fruitsCutCount} Frutas`;
    document.getElementById('hud-missed').innerText = `⚠️ ${missedFruitCount}/5 perdidas`;
    document.getElementById('hud-multiplier').innerText = `${currentMultiplier.toFixed(2)}x`;
    document.getElementById('hud-level').innerText = `⚡ NÍVEL ${currentLevel}`;
    
    const percentGain = getRewardRate(Math.max(1, fruitsCutCount));
    const gainPerFruit = (currentBetAmount * percentGain);

    document.getElementById('hud-fruit-rate').innerText = `+R$ ${gainPerFruit.toFixed(2)}/fruta (+${(percentGain * 100).toFixed(1)}%)`;

    const formattedWin = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(currentWinAmount);
    document.getElementById('hud-current-win').innerText = formattedWin;
    const cashoutButton = document.getElementById('cashout-btn');
    const canCashout = gameState === 'PLAYING' && currentMultiplier >= MIN_CASHOUT_MULTIPLIER;
    cashoutButton.disabled = !canCashout;
    document.getElementById('cashout-btn-amount').innerText = canCashout
        ? `(${formattedWin} • LIBERADO!)`
        : `(bloqueado até ${MIN_CASHOUT_MULTIPLIER.toFixed(2)}x)`;
}

async function startNinjaGame() {
    if (gameState === 'PLAYING') return;

    if (!authToken) {
        openModal('login-modal');
        return;
    }

    const betInput = parseFloat(document.getElementById('bet-amount').value);
    if (isNaN(betInput) || betInput <= 0) {
        showToast('Informe um valor de aposta válido!', 'error');
        return;
    }

    currentBetAmount = betInput;

    try {
        const res = await fetch('/api/game/ninja/start', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({ bet_amount: currentBetAmount })
        });
        const data = await res.json();

        if (res.ok) {
            currentSessionId = data.session_id;
            updateBalanceDisplay(data.new_balance);

            // Reiniciar variáveis de rodada e Nível
            gameState = 'PLAYING';
            fruitsCutCount = 0;
            missedFruitCount = 0;
            currentLevel = 1;
            levelUpNotice = null;
            currentMultiplier = 1.0;
            currentWinAmount = currentBetAmount;
            objects = [];
            splatters = [];
            floatingTexts = [];

            updateHUD();

            // Esconder overlay e trocar botões
            document.getElementById('ninja-overlay').classList.add('hidden');
            document.getElementById('start-btn').classList.add('hidden');
            document.getElementById('cashout-btn').classList.remove('hidden');

        showToast(`🎮 Partida iniciada com Aposta de R$ ${currentBetAmount.toFixed(2)}! Mostre sua habilidade!`, 'info');
        } else {
            showToast(data.message, 'error');
            if (data.message.includes('insuficiente')) openModal('deposit-modal');
        }
    } catch (err) {
        showToast('Erro ao iniciar partida.', 'error');
    }
}

async function cashoutNinjaGame() {
    if (gameState !== 'PLAYING' || !currentSessionId) return;
    if (currentMultiplier < MIN_CASHOUT_MULTIPLIER) {
        showToast(`🔒 Cash Out liberado somente em ${MIN_CASHOUT_MULTIPLIER.toFixed(2)}x. Continue cortando com precisão!`, 'warning');
        return;
    }

    try {
        const res = await fetch('/api/game/ninja/cashout', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({
                session_id: currentSessionId,
                multiplier: currentMultiplier,
                fruits_cut: fruitsCutCount,
                hit_bomb: false
            })
        });
        const data = await res.json();

        if (res.ok) {
            gameState = 'IDLE';
            playCashoutSound();
            updateBalanceDisplay(data.new_balance);

            const overlay = document.getElementById('ninja-overlay');
            document.getElementById('overlay-title').innerText = '🎉 CASH OUT REALIZADO!';
            document.getElementById('overlay-subtitle').innerText = `Incrível! Você fatiou ${fruitsCutCount} frutas no Nível ${currentLevel} e faturou R$ ${data.payout.toFixed(2)} (${data.multiplier.toFixed(2)}x)!`;
            overlay.classList.remove('hidden');

            document.getElementById('start-btn').classList.remove('hidden');
            document.getElementById('cashout-btn').classList.add('hidden');

            showToast(`🏆 Vitória Extraordinária! R$ ${data.payout.toFixed(2)} creditados!`, 'success');
            loadLiveWins();
        } else {
            showToast(data.message, 'error');
        }
    } catch (err) {
        showToast('Erro ao realizar Cash Out.', 'error');
    }
}

async function triggerGameOver(reason = 'bomb') {
    if (gameState !== 'PLAYING') return;
    gameState = 'GAMEOVER';

    const failedSessionId = currentSessionId;
    currentSessionId = null;

    try {
        await fetch('/api/game/ninja/cashout', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
            },
            body: JSON.stringify({
                session_id: failedSessionId,
                multiplier: 0.0,
                fruits_cut: fruitsCutCount,
                hit_bomb: true
            })
        });
    } catch (e) {}

    const overlay = document.getElementById('ninja-overlay');
    const missedTooManyFruits = reason === 'missed';
    document.getElementById('overlay-title').innerText = missedTooManyFruits ? '⌛ 5 FRUTAS ESCAPARAM!' : '💥 BOOM! BOMBA FATIADA!';
    document.getElementById('overlay-subtitle').innerText = missedTooManyFruits
        ? `Você deixou 5 frutas passarem no Nível ${currentLevel}. Aposta de R$ ${currentBetAmount.toFixed(2)} perdida. Mantenha a precisão e tente novamente!`
        : `Você acertou uma bomba no Nível ${currentLevel}! Aposta de R$ ${currentBetAmount.toFixed(2)} perdida. Treine seus reflexos e tente novamente!`;
    overlay.classList.remove('hidden');

    document.getElementById('start-btn').classList.remove('hidden');
    document.getElementById('cashout-btn').classList.add('hidden');

    showToast(missedTooManyFruits ? '⌛ Cinco frutas escaparam! Fim de jogo.' : '💣 Você cortou uma bomba! Fim de jogo.', 'error');
}

