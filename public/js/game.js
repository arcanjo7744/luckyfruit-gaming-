// MOTOR GRÁFICO & FÍSICA DO JOGO FRUIT NINJA (DIFICULDADE PROGRESSIVA POR NÍVEIS)

let gameState = 'IDLE'; // 'IDLE', 'PLAYING', 'GAMEOVER'
let currentSessionId = null;
let currentBetAmount = 5.0;
let fruitsCutCount = 0;
let currentMultiplier = 1.0;
let currentWinAmount = 0.0;

let currentLevel = 1;
let lastLevelTriggered = 1;
let levelUpNotice = null; // Banner flutuante no Canvas

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
    playTone(600, 0.05, 'triangle');
    setTimeout(() => playTone(1200, 0.04, 'sine'), 30);
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
let bladeTrail = [];

const FRUIT_TYPES = [
    { name: 'Morango', icon: '🍓', color: '#EF4444', baseValue: 0.15 },
    { name: 'Melancia', icon: '🍉', color: '#10B981', baseValue: 0.20 },
    { name: 'Uva', icon: '🍇', color: '#8B5CF6', baseValue: 0.15 },
    { name: 'Banana', icon: '🍌', color: '#F59E0B', baseValue: 0.12 },
    { name: 'Laranja', icon: '🍊', color: '#F97316', baseValue: 0.10 },
    { name: 'Limão', icon: '🍋', color: '#84CC16', baseValue: 0.10 },
    { name: 'Abacaxi', icon: '🍍', color: '#EAB308', baseValue: 0.25 },
    { name: 'Coco', icon: '🥥', color: '#A1A1AA', baseValue: 0.20 }
];

class GameObject {
    constructor(isBomb = false, level = 1) {
        this.isBomb = isBomb;
        this.radius = isBomb ? 26 : 30;
        this.x = Math.random() * (canvas.width - 120) + 60;
        this.y = canvas.height + 40;
        
        // Multiplicador de velocidade baseado no Nível Atual
        const speedBoost = 1.0 + (level - 1) * 0.20; // +20% de velocidade por nível
        
        const targetX = canvas.width / 2 + (Math.random() - 0.5) * 350;
        this.vx = ((targetX - this.x) / 42) * speedBoost;
        this.vy = -(Math.random() * 4.5 + 13.5) * speedBoost;
        this.gravity = 0.36 * speedBoost;
        
        this.rotation = Math.random() * Math.PI * 2;
        this.vRot = (Math.random() - 0.5) * (0.15 * speedBoost);
        
        this.sliced = false;
        
        if (!isBomb) {
            const fruitData = FRUIT_TYPES[Math.floor(Math.random() * FRUIT_TYPES.length)];
            this.icon = fruitData.icon;
            this.color = fruitData.color;
            // Bônus de bônus por fruta em níveis mais altos
            this.value = roundVal(fruitData.baseValue + (level - 1) * 0.05, 2);
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
        
        // Desenhar sombra
        ctx.shadowColor = this.isBomb ? 'rgba(239, 68, 68, 0.8)' : 'rgba(0, 0, 0, 0.4)';
        ctx.shadowBlur = this.isBomb ? 18 : 8;

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
                // BOMBA CUT: EXPLOSÃO E FIM DE PARTIDA
                playBombExplodeSound();
                createExplosion(obj.x, obj.y);
                triggerGameOver();
            } else {
                // FRUTA FATIADA
                playSliceSound();
                fruitsCutCount++;
                currentMultiplier = roundVal(currentMultiplier + obj.value, 2);
                currentWinAmount = roundVal(currentBetAmount * currentMultiplier, 2);
                
                // VERIFICAR AUMENTO DE NÍVEL (A CADA 6 FRUTAS)
                const newLevel = Math.floor(fruitsCutCount / 6) + 1;
                if (newLevel > currentLevel) {
                    currentLevel = newLevel;
                    playLevelUpSound();
                    levelUpNotice = {
                        text: `⚡ NÍVEL ${currentLevel}! VELOCIDADE +20% | BÔNUS DE MULTIPLICADOR!`,
                        alpha: 1.0,
                        scale: 1.4
                    };
                    showToast(`🔥 Nível ${currentLevel}! A velocidade e quantidade de bombas aumentaram!`, 'warning');
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

    // Spawning Dinâmico com Dificuldade RAMP-UP por Nível
    if (gameState === 'PLAYING') {
        // Intervalo de lançamento diminui conforme o nível (mínimo 500ms)
        const spawnInterval = Math.max(520, 1150 - (currentLevel - 1) * 140);

        if (timestamp - lastSpawnTime > spawnInterval) {
            lastSpawnTime = timestamp;
            
            // Lançar mais objetos em níveis altos
            const spawnCount = currentLevel >= 3 ? (Math.random() < 0.6 ? 2 : 3) : (Math.random() < 0.5 ? 1 : 2);
            
            // Probabilidade de bomba aumenta a cada nível (até 50%)
            const bombChance = Math.min(0.50, 0.22 + (currentLevel - 1) * 0.07);

            for (let i = 0; i < spawnCount; i++) {
                const isBomb = Math.random() < bombChance;
                objects.push(new GameObject(isBomb, currentLevel));
            }
        }
    } else if (gameState === 'IDLE') {
        // Modo Demo
        if (timestamp - lastSpawnTime > 2500) {
            lastSpawnTime = timestamp;
            objects.push(new GameObject(false, 1));
        }
    }

    // Atualizar e desenhar objetos voador
    for (let i = objects.length - 1; i >= 0; i--) {
        const obj = objects[i];
        obj.update();
        obj.draw(ctx);
        if (obj.y > canvas.height + 60) {
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
        ctx.font = '900 18px Poppins, sans-serif';
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
}

function updateHUD() {
    document.getElementById('hud-fruits-cut').innerText = `🍓 ${fruitsCutCount}`;
    document.getElementById('hud-multiplier').innerText = `${currentMultiplier.toFixed(2)}x`;
    document.getElementById('hud-level').innerText = `⚡ NÍVEL ${currentLevel}`;
    
    const formattedWin = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(currentWinAmount);
    document.getElementById('hud-current-win').innerText = formattedWin;
    document.getElementById('cashout-btn-amount').innerText = formattedWin;
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
            currentLevel = 1;
            levelUpNotice = null;
            currentMultiplier = 1.0;
            currentWinAmount = currentBetAmount;
            objects = [];
            splatters = [];

            updateHUD();

            // Esconder overlay e trocar botões
            document.getElementById('ninja-overlay').classList.add('hidden');
            document.getElementById('start-btn').classList.add('hidden');
            document.getElementById('cashout-btn').classList.remove('hidden');

            showToast('🎮 Partida iniciada no Nível 1! Fatie as frutas!', 'info');
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
            document.getElementById('overlay-subtitle').innerText = `Você fatiou ${fruitsCutCount} frutas (Alcançou o Nível ${currentLevel}) e faturou R$ ${data.payout.toFixed(2)} (${data.multiplier.toFixed(2)}x)!`;
            overlay.classList.remove('hidden');

            document.getElementById('start-btn').classList.remove('hidden');
            document.getElementById('cashout-btn').classList.add('hidden');

            showToast(`🏆 Vitória! R$ ${data.payout.toFixed(2)} creditados!`, 'success');
            loadLiveWins();
        } else {
            showToast(data.message, 'error');
        }
    } catch (err) {
        showToast('Erro ao realizar Cash Out.', 'error');
    }
}

async function triggerGameOver() {
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
    document.getElementById('overlay-title').innerText = '💥 BOOM! BOMBA FATIADA!';
    document.getElementById('overlay-subtitle').innerText = `Você acertou uma bomba no Nível ${currentLevel}! Aposta de R$ ${currentBetAmount.toFixed(2)} perdida. Tente novamente!`;
    overlay.classList.remove('hidden');

    document.getElementById('start-btn').classList.remove('hidden');
    document.getElementById('cashout-btn').classList.add('hidden');

    showToast('💣 Você cortou uma bomba! Fim de jogo.', 'error');
}
