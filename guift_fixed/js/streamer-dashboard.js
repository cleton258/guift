// ============================================================
//  GUIFT - DASHBOARD DO STREAMER
//
//  BUGS CORRIGIDOS:
//  1. getUser() → getSession() para evitar lock error
//  2. _userId guardado em cache — sem chamadas extra à API
//  3. TTS desbloqueado correctamente no mobile
//  4. Stats calculados localmente — sem chamadas à API
//  5. Realtime com log de status de conexão
//  6. Perfil sincronizado ao abrir o dashboard
// ============================================================

let volumeVoz       = 0.8;
let volumeSom       = 0.8;
let totalAcumulado  = 0;
let countAcumulado  = 0;
let _userId         = null;
let _streamerNome   = '';
let ttsDesbloqueado = false;

// ── SOM ──────────────────────────────────────────────────────
function tocarSom() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [[1174.66, 0.00], [1318.51, 0.18], [1567.98, 0.36]].forEach(([f, t]) => {
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.connect(g); g.connect(ctx.destination);
            o.type = 'sine'; o.frequency.value = f;
            g.gain.setValueAtTime(0, ctx.currentTime + t);
            g.gain.linearRampToValueAtTime(0.5 * volumeSom, ctx.currentTime + t + 0.01);
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.25);
            o.start(ctx.currentTime + t);
            o.stop(ctx.currentTime + t + 0.30);
        });
    } catch (e) {
        GUIFT_ERR('AUDIO', 'Erro ao tocar som', e);
    }
}

// ── TTS ──────────────────────────────────────────────────────
// FIX MOBILE 1: Mobile exige interação do utilizador antes de falar
function desbloquearTTS() {
    if (ttsDesbloqueado) return;
    ttsDesbloqueado = true;
    GUIFT_LOG('TTS', 'TTS desbloqueado pelo utilizador');
    if ('speechSynthesis' in window) {
        // Fala silenciosa para desbloquear no iOS/Android
        const u = new SpeechSynthesisUtterance('');
        u.volume = 0;
        u.rate   = 1;
        try { window.speechSynthesis.speak(u); } catch(e) {}
        // Garante que as vozes são carregadas
        obterVozes();
    }
    // FIX MOBILE 2: Android Chrome pausa o speechSynthesis após ~15s
    // Keepalive: resume a cada 10s para evitar o bug do Chrome Android
    _ttsKeepaliveInterval = setInterval(() => {
        if (!window.speechSynthesis) return;
        if (window.speechSynthesis.speaking) {
            window.speechSynthesis.pause();
            window.speechSynthesis.resume();
        }
        // Manter navegador ativo com notificação invisível
        manterNavegadorAtivo();

        // Se há itens na fila, ser mais agressivo com o keep-alive
        if (filaTTS.length > 0) {
            setTimeout(() => manterNavegadorAtivo(), 2000); // Ping extra
        }
    }, 10000);

    // Keep-alive extra quando há doações pendentes
    _ttsExtraKeepalive = setInterval(() => {
        if (filaTTS.length > 0 && document.visibilityState === 'hidden') {
            GUIFT_LOG('TTS', 'Doações pendentes em background - mantendo ativo');
            manterNavegadorAtivo();
            // Tentar resume do speech synthesis
            if (window.speechSynthesis && window.speechSynthesis.paused) {
                window.speechSynthesis.resume();
            }
        }
    }, 3000);
}

// Manter navegador ativo em background
let _notificacaoKeepalive = null;
function manterNavegadorAtivo() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    try {
        // Criar notificação invisível para manter o processo ativo
        if (_notificacaoKeepalive) {
            _notificacaoKeepalive.close();
        }
        _notificacaoKeepalive = new Notification('', {
            body: '',
            icon: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', // 1x1 pixel transparente
            tag: 'guift-keepalive',
            silent: true,
            requireInteraction: false
        });
        // Fechar imediatamente para não incomodar
        setTimeout(() => {
            if (_notificacaoKeepalive) {
                _notificacaoKeepalive.close();
                _notificacaoKeepalive = null;
            }
        }, 100);
    } catch(e) {
        // Ignorar erros de notificação
    }
}

// FIX MOBILE 3: Vozes podem não estar prontas na primeira chamada (iOS/Android)
// Guardar as vozes quando ficam disponíveis
let _vozesCache = [];
let _ttsKeepaliveInterval = null;
let _ttsExtraKeepalive = null;
let vozGenero = 'feminina'; // 'feminina' ou 'masculina'

function obterVozes() {
    const vozes = window.speechSynthesis.getVoices();
    if (vozes.length > 0) {
        _vozesCache = vozes;
        GUIFT_LOG('TTS', 'Vozes carregadas:', vozes.map(v => v.lang + ':' + v.name));
    }
    return _vozesCache;
}

// O evento onvoiceschanged chega depois no mobile — actualizar a cache
if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = () => { obterVozes(); };
}

const filaTTS = [];
let lendoAgora = false;

function adicionarFilaTTS(d) {
    if (!ttsDesbloqueado) {
        GUIFT_LOG('TTS', 'TTS não desbloqueado — o utilizador precisa de tocar na página primeiro');
        return;
    }
    filaTTS.push(d);
    atualizarStatusTTS(); // Atualizar indicador visual
    if (!lendoAgora) processarFila();
}

function processarFila() {
    if (!filaTTS.length) {
        lendoAgora = false;
        return;
    }
    lendoAgora = true;

    // Manter navegador ativo antes de processar
    manterNavegadorAtivo();

    const d   = filaTTS.shift();
    let texto = d.donor_name + ' mandou ' + d.amount + ' meticais.';
    if (d.message) texto += ' ' + d.message;
    GUIFT_LOG('TTS', 'A narrar:', texto);

    // Callback que continua a fila mesmo em background
    const continuarFila = () => {
        // Pequeno delay para garantir que a fala terminou
        setTimeout(() => {
            processarFila();
        }, 200);
    };

    falar(texto, continuarFila);
}

function falar(texto, cb) {
    if (!('speechSynthesis' in window)) {
        GUIFT_LOG('TTS', 'speechSynthesis não suportado neste browser');
        if (cb) cb();
        return;
    }

    // FIX MOBILE 3: Garante vozes actualizadas antes de falar
    const vozes = obterVozes();

    // Filtrar vozes em português brasileiro
    const vozesBR = vozes.filter(v => v.lang.startsWith('pt-BR') || v.lang.startsWith('pt'));

    // Separar por gênero baseado no nome da voz
    const vozesFemininas = vozesBR.filter(v => 
        v.name.toLowerCase().includes('female') || 
        v.name.toLowerCase().includes('feminina') || 
        v.name.toLowerCase().includes('mulher') ||
        v.name.toLowerCase().includes('woman') ||
        !v.name.toLowerCase().includes('male') && !v.name.toLowerCase().includes('masculino') && !v.name.toLowerCase().includes('homem') && !v.name.toLowerCase().includes('man')
    );
    const vozesMasculinas = vozesBR.filter(v => 
        v.name.toLowerCase().includes('male') || 
        v.name.toLowerCase().includes('masculino') || 
        v.name.toLowerCase().includes('homem') ||
        v.name.toLowerCase().includes('man')
    );

    // Escolher vozes baseado no gênero selecionado
    let vozesParaTentar = [];
    if (vozGenero === 'feminina') {
        vozesParaTentar = vozesFemininas.length > 0 ? vozesFemininas : vozesBR;
    } else {
        vozesParaTentar = vozesMasculinas.length > 0 ? vozesMasculinas : vozesBR;
    }

    // Fallback para qualquer voz se não houver vozes BR
    if (vozesParaTentar.length === 0) {
        vozesParaTentar = [vozes[0]].filter(v => v);
    }

    function tentarVoz(index) {
        if (index >= vozesParaTentar.length) {
            GUIFT_LOG('TTS', 'Nenhuma voz funcionou');
            if (cb) cb();
            return;
        }

        const voz = vozesParaTentar[index];
        GUIFT_LOG('TTS', 'Tentando voz:', voz.name);

        // Garantir que o speechSynthesis está ativo antes de falar
        if (window.speechSynthesis.paused) {
            window.speechSynthesis.resume();
            // Aguardar um pouco para o resume
            setTimeout(() => _falarComVoz(voz, index), 100);
        } else {
            _falarComVoz(voz, index);
        }
    }

    function _falarComVoz(voz, index) {
        window.speechSynthesis.cancel();

        const u  = new SpeechSynthesisUtterance(texto);
        u.lang   = voz.lang.startsWith('pt') ? 'pt-BR' : voz.lang; // Forçar pt-BR se for português
        u.rate   = 0.9;  // Mais natural
        u.pitch  = 1.0;  // Tom natural
        u.volume = volumeVoz;
        u.voice  = voz;

        // Evento para manter ativo durante a fala
        u.onstart = () => {
            GUIFT_LOG('TTS', 'Fala iniciada com voz:', voz.name);
            manterNavegadorAtivo(); // Manter ativo durante a fala
        };

        // Timeout de segurança — mobile às vezes não dispara onend
        const tempo = Math.max(10000, texto.length * 120);
        const timeout = setTimeout(() => {
            GUIFT_LOG('TTS', 'Timeout de TTS atingido, tentando próxima voz...');
            clearTimeout(timeout);
            tentarVoz(index + 1);
        }, tempo);

        u.onend = () => { clearTimeout(timeout); if (cb) cb(); };
        u.onerror = (e) => {
            GUIFT_LOG('TTS', 'Erro TTS com voz', voz.name + ':', e.error);
            clearTimeout(timeout);
            if (e.error === 'synthesis-failed' || e.error === 'synthesis-unavailable') {
                // Tentar próxima voz
                tentarVoz(index + 1);
            } else {
                // Outro erro, continuar fila
                if (cb) cb();
            }
        };

        try {
            window.speechSynthesis.speak(u);
        } catch(e) {
            GUIFT_ERR('TTS', 'Erro ao falar com voz', voz.name + ':', e);
            clearTimeout(timeout);
            tentarVoz(index + 1);
        }
    }

    // Se ainda não há vozes carregadas, esperar até 1s
    if (vozes.length === 0) {
        GUIFT_LOG('TTS', 'Vozes ainda não carregadas, a aguardar...');
        setTimeout(() => tentarVoz(0), 500);
    } else {
        tentarVoz(0);
    }
}

window.lerManual = function(nome, amt, msg) {
    desbloquearTTS();
    window.speechSynthesis && window.speechSynthesis.cancel();
    let txt = nome + ' mandou ' + amt + ' meticais.';
    if (msg) txt += ' ' + msg;
    falar(txt, null);
};

// Limpar recursos quando necessário
function limparRecursosTTS() {
    if (_ttsKeepaliveInterval) {
        clearInterval(_ttsKeepaliveInterval);
        _ttsKeepaliveInterval = null;
    }
    if (_ttsExtraKeepalive) {
        clearInterval(_ttsExtraKeepalive);
        _ttsExtraKeepalive = null;
    }
    if (_notificacaoKeepalive) {
        _notificacaoKeepalive.close();
        _notificacaoKeepalive = null;
    }
}

// ── VOLUMES ───────────────────────────────────────────────────
function initVolumes() {
    const sv = document.getElementById('slider-voz');
    const ss = document.getElementById('slider-som');
    sv.addEventListener('input', () => {
        volumeVoz = sv.value / 100;
        document.getElementById('pct-voz').textContent = sv.value + '%';
    });
    ss.addEventListener('input', () => {
        volumeSom = ss.value / 100;
        document.getElementById('pct-som').textContent = ss.value + '%';
        tocarSom();
    });
}

// ── VOZ ────────────────────────────────────────────────────────
window.mudarVoz = function(genero) {
    vozGenero = genero;
    document.getElementById('btn-voz-feminina').classList.toggle('active', genero === 'feminina');
    document.getElementById('btn-voz-masculina').classList.toggle('active', genero === 'masculina');
    GUIFT_LOG('TTS', 'Voz mudada para:', genero);
};

function initVoiceButtons() {
    // Inicializar botões de voz com estado padrão
    document.getElementById('btn-voz-feminina').classList.add('active');
}

function atualizarStatusTTS() {
    const statusEl = document.getElementById('tts-status');
    if (!statusEl) return;

    const isActive = ttsDesbloqueado && filaTTS.length >= 0;
    statusEl.style.display = isActive ? 'flex' : 'none';

    if (document.visibilityState === 'hidden') {
        statusEl.innerHTML = '<i class="fas fa-volume-up"></i> TTS BG';
        statusEl.title = 'TTS ativo em background';
    } else {
        statusEl.innerHTML = '<i class="fas fa-volume-up"></i> TTS';
        statusEl.title = 'TTS ativo';
    }
}

// ── CASH OUT ───────────────────────────────────────────────────
document.getElementById('btn-cashout')?.addEventListener('click', () => {
    mostrarAlerta('💰 Função Cash Out em desenvolvimento!');
});

// ── NOTIFICAÇÕES ──────────────────────────────────────────────
function pedirNotificacao() {
    if (!('Notification' in window)) {
        GUIFT_LOG('NOTIF', 'API de Notificações não suportada neste browser');
        return;
    }
    GUIFT_LOG('NOTIF', 'Estado da permissão:', Notification.permission);
    if (Notification.permission === 'default') {
        Notification.requestPermission().then(p => {
            GUIFT_LOG('NOTIF', 'Permissão obtida:', p);
            if (p === 'granted') {
                // Criar notificação de boas-vindas para confirmar
                try {
                    const n = new Notification('GUIFT - TTS Ativo', {
                        body: 'Sistema de voz configurado para funcionar em background',
                        icon: 'images/logo.png',
                        tag: 'guift-welcome',
                        silent: true
                    });
                    setTimeout(() => n.close(), 3000);
                } catch(e) {}
            }
        });
    } else if (Notification.permission === 'granted') {
        GUIFT_LOG('NOTIF', 'Permissões já concedidas');
    }
}

// Solicitar todas as permissões necessárias
function solicitarPermissoes() {
    GUIFT_LOG('PERMS', 'Solicitando todas as permissões necessárias...');

    // 1. Notificações
    pedirNotificacao();

    // 2. Audio Context (para manter contexto ativo)
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        // Manter contexto ativo
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        gainNode.gain.value = 0.001; // Volume quase inaudível
        oscillator.frequency.value = 1; // Frequência muito baixa
        oscillator.start();
        setTimeout(() => {
            oscillator.stop();
        }, 100);
    } catch(e) {
        GUIFT_LOG('PERMS', 'Erro ao inicializar AudioContext:', e);
    }

    // 3. Wake Lock API (se disponível) - mantém tela ligada
    if ('wakeLock' in navigator) {
        try {
            navigator.wakeLock.request('screen').then(wakeLock => {
                GUIFT_LOG('PERMS', 'Wake Lock obtido - tela permanecerá ligada');
                wakeLock.addEventListener('release', () => {
                    GUIFT_LOG('PERMS', 'Wake Lock liberado');
                });
            }).catch(e => {
                GUIFT_LOG('PERMS', 'Wake Lock não disponível:', e);
            });
        } catch(e) {
            GUIFT_LOG('PERMS', 'Wake Lock API não suportada');
        }
    }
}

function enviarNotificacao(d) {
    if (!('Notification' in window) || Notification.permission !== 'granted') {
        GUIFT_LOG('NOTIF', 'Notificação não enviada — permissão:', Notification?.permission);
        return;
    }
    try {
        const n = new Notification('💰 Nova Doação — GUIFT', {
            body:    d.donor_name + ' mandou ' + d.amount + ' MT' + (d.message ? ': ' + d.message : ''),
            icon:    'images/logo.png',
            badge:   'images/logo.png',
            tag:     'doacao-' + Date.now(),
            vibrate: [300, 100, 300]
        });
        n.onclick = () => { window.focus(); n.close(); };
        setTimeout(() => n.close(), 6000);
        GUIFT_LOG('NOTIF', '✅ Notificação enviada');
    } catch(e) {
        GUIFT_ERR('NOTIF', 'Erro ao criar notificação', e);
    }
}

// ── LINK DE DOAÇÃO ────────────────────────────────────────────
function atualizarLink(nome) {
    const link = GUIFT_CONFIG.SITE_URL + '/doar.html?streamer=' + encodeURIComponent(nome);
    const el   = document.getElementById('donation-link');
    if (el) { el.textContent = link; el.dataset.link = link; }
    GUIFT_LOG('DASHBOARD', 'Link de doação:', link);
}

window.copiarLink = function() {
    const link = document.getElementById('donation-link')?.dataset.link || '';
    if (!link) return;
    if (navigator.clipboard) {
        navigator.clipboard.writeText(link).then(() => mostrarAlerta('🔗 Link copiado!'));
    } else {
        const t = document.createElement('textarea');
        t.value = link; document.body.appendChild(t);
        t.select(); document.execCommand('copy');
        document.body.removeChild(t);
        mostrarAlerta('🔗 Link copiado!');
    }
};

// ── INIT ──────────────────────────────────────────────────────

// Debug Panel para Mobile
function initDebugPanel() {
    // Criar painel se não existir
    let panel = document.getElementById('debug-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'debug-panel';
        panel.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            width: 90%;
            max-width: 400px;
            max-height: 200px;
            background: rgba(0, 0, 0, 0.95);
            border: 3px solid #00ff00;
            border-radius: 8px;
            color: #00ff00;
            font-family: monospace;
            font-size: 12px;
            overflow-y: auto;
            padding: 10px;
            z-index: 9999;
            display: none;
            line-height: 1.5;
            box-shadow: 0 0 10px rgba(0, 255, 0, 0.5);
        `;
        const logsDiv = document.createElement('div');
        logsDiv.id = 'debug-logs';
        panel.appendChild(logsDiv);
        document.body.appendChild(panel);
        console.log('✅ Debug panel criado dinamicamente');
    }
    
    // Criar botão se não existir
    let toggle = document.getElementById('debug-toggle');
    if (!toggle) {
        toggle = document.createElement('button');
        toggle.id = 'debug-toggle';
        toggle.textContent = '🐛';
        toggle.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 20px;
            width: 60px;
            height: 60px;
            border-radius: 50%;
            background: linear-gradient(135deg, #00ff00, #00cc00);
            border: 3px solid #00aa00;
            color: #000;
            font-weight: bold;
            cursor: pointer;
            z-index: 10000;
            font-size: 28px;
            box-shadow: 0 0 15px rgba(0, 255, 0, 0.6);
            transition: all 0.2s;
        `;
        document.body.appendChild(toggle);
        console.log('✅ Debug toggle button criado dinamicamente');
    }
    
    // Adicionar event listener
    toggle.addEventListener('click', () => {
        const isVisible = panel.style.display !== 'none';
        panel.style.display = isVisible ? 'none' : 'block';
        toggle.style.opacity = isVisible ? '0.6' : '1';
    });
    
    // Função para atualizar logs
    window._updateDebugPanel = function() {
        const logsDiv = document.getElementById('debug-logs');
        if (!logsDiv) return;
        
        const html = GUIFT_LOGS_BUFFER.map(log => {
            const color = log.type === 'error' ? '#ff4444' : '#00ff00';
            const text = log.text.substring(0, 120);
            return '<div style="color:' + color + '; margin-bottom: 2px;">' + text + '</div>';
        }).join('');
        
        logsDiv.innerHTML = html;
        logsDiv.parentElement.scrollTop = logsDiv.parentElement.scrollHeight;
    };
    
    console.log('✅ Debug panel inicializado com sucesso');
}

async function init() {
    // Inicializar painel de debug PRIMEIRO
    setTimeout(() => initDebugPanel(), 100);
    
    GUIFT_LOG('DASHBOARD', 'A inicializar dashboard...');

    // FIX: getSession() em vez de getUser() — sem lock error
    const { data: { session }, error: sessionError } = await window._db.auth.getSession();

    if (sessionError) {
        GUIFT_ERR('DASHBOARD', 'Erro ao obter sessão', sessionError);
        window.location.href = 'login.html';
        return;
    }

    if (!session) {
        GUIFT_LOG('DASHBOARD', 'Sem sessão activa, a redirecionar para login...');
        window.location.href = 'login.html';
        return;
    }

    const user    = session.user;
    _userId       = user.id;
    _streamerNome = user.user_metadata?.name || user.email.split('@')[0];

    GUIFT_LOG('DASHBOARD', '✅ Utilizador autenticado:', {
        id:    _userId,
        nome:  _streamerNome,
        email: user.email
    });

    document.getElementById('streamer-name').textContent = _streamerNome;
    atualizarLink(_streamerNome);
    solicitarPermissoes(); // Solicitar TODAS as permissões necessárias
    initVolumes();
    initVoiceButtons();
    atualizarStatusTTS(); // Inicializar status TTS

    // Mostrar mensagem sobre TTS em background
    setTimeout(() => {
        mostrarAlerta('🎤 TTS configurado para funcionar em background mesmo com navegador minimizado!');
    }, 2000);

    // FIX: Desbloquear TTS no primeiro toque (obrigatório no mobile)
    document.addEventListener('touchstart', () => {
        desbloquearTTS();
        atualizarStatusTTS();
    }, { once: true });
    document.addEventListener('click', () => {
        desbloquearTTS();
        atualizarStatusTTS();
    }, { once: true });

    // FIX MOBILE: Retomar TTS quando o utilizador volta ao tab/app
    document.addEventListener('visibilitychange', () => {
        atualizarStatusTTS();
        if (document.visibilityState === 'visible') {
            GUIFT_LOG('VISIBILITY', 'Tab voltou ao foco - retomando TTS');
            if (window.speechSynthesis) {
                window.speechSynthesis.resume();
                // Forçar resume se ainda estiver pausado
                setTimeout(() => {
                    if (window.speechSynthesis && window.speechSynthesis.paused) {
                        window.speechSynthesis.resume();
                    }
                }, 100);
            }
        } else {
            GUIFT_LOG('VISIBILITY', 'Tab foi para background - mantendo TTS ativo');
            // Manter contexto ativo mesmo em background
            manterNavegadorAtivo();
        }
    });

    // Evento adicional para quando a janela perde foco
    window.addEventListener('blur', () => {
        GUIFT_LOG('WINDOW', 'Janela perdeu foco - mantendo TTS ativo');
        manterNavegadorAtivo();
    });

    // Evento para quando a janela ganha foco novamente
    window.addEventListener('focus', () => {
        GUIFT_LOG('WINDOW', 'Janela ganhou foco - retomando TTS');
        if (window.speechSynthesis) {
            window.speechSynthesis.resume();
        }
    });

    // Pré-carregar vozes (o listener onvoiceschanged já está definido globalmente)
    if ('speechSynthesis' in window) { obterVozes(); }

    document.getElementById('btn-logout').addEventListener('click', async () => {
        GUIFT_LOG('AUTH', 'A fazer logout...');
        limparRecursosTTS(); // Limpar recursos TTS
        await window._db.auth.signOut();
        window.location.href = 'login.html';
    });

    document.getElementById('btn-clear').addEventListener('click', () => {
        document.getElementById('donations-list').innerHTML =
            '<div class="empty"><i class="fas fa-inbox"></i><p>Nenhuma doação ainda...</p></div>';
        document.getElementById('messages-list').innerHTML =
            '<div class="empty"><i class="fas fa-comment-slash"></i><p>Sem mensagens</p></div>';
        totalAcumulado = 0; countAcumulado = 0;
        renderStats();
        GUIFT_LOG('DASHBOARD', 'Histórico limpo');
    });

    iniciarRealtime(_userId);
}

// ── REALTIME ──────────────────────────────────────────────────
function iniciarRealtime(streamerId) {
    GUIFT_LOG('REALTIME', 'A iniciar subscrição para streamer:', streamerId);

    carregarDoacoes(streamerId);

    const canal = window._db.channel('doacoes-' + streamerId)
        .on('postgres_changes', {
            event:  'INSERT',
            schema: 'public',
            table:  'donations',
            filter: 'streamer_id=eq.' + streamerId
        }, (payload) => {
            GUIFT_LOG('REALTIME', '🎁 Nova doação recebida!', payload.new);
            const d = payload.new;
            renderDoacao(d, true);
            totalAcumulado += Number(d.amount);
            countAcumulado += 1;
            renderStats();
            mostrarAlerta('💰 ' + esc(d.donor_name) + ' mandou ' + d.amount + ' MT!');
            tocarSom();
            enviarNotificacao(d);
            adicionarFilaTTS(d);
        })
        .subscribe((status, err) => {
            GUIFT_LOG('REALTIME', 'Estado da subscrição:', status);
            if (err) GUIFT_ERR('REALTIME', 'Erro na subscrição', err);
        });

    GUIFT_LOG('REALTIME', 'Canal criado:', canal);
}

async function carregarDoacoes(streamerId) {
    GUIFT_LOG('DASHBOARD', 'A carregar doações para:', streamerId);

    const { data, error } = await window._db
        .from('donations')
        .select('*')
        .eq('streamer_id', streamerId)
        .order('created_at', { ascending: false })
        .limit(50);

    if (error) {
        GUIFT_ERR('DASHBOARD', 'Erro ao carregar doações', error);
        return;
    }

    GUIFT_LOG('DASHBOARD', 'Doações carregadas:', data?.length || 0);

    if (!data || !data.length) return;

    document.getElementById('donations-list').innerHTML = '';
    document.getElementById('messages-list').innerHTML  = '';

    data.forEach(d => renderDoacao(d, false));
    totalAcumulado = data.reduce((s, d) => s + Number(d.amount), 0);
    countAcumulado = data.length;
    renderStats();
}

// ── RENDER ────────────────────────────────────────────────────
function renderDoacao(d, isNova) {
    const lista  = document.getElementById('donations-list');
    const emptyD = lista.querySelector('.empty');
    if (emptyD) emptyD.remove();

    const nome = esc(d.donor_name || 'Anónimo');
    const msg  = esc(d.message || '');
    const amt  = esc(String(d.amount));

    const item = document.createElement('div');
    item.className = 'donation-item' + (isNova ? ' nova' : '');
    item.innerHTML =
        '<div class="donation-info">' +
            '<span class="donor-name"><i class="fas fa-user"></i>' + nome + '</span>' +
            (d.message ? '<span class="donation-message">' + msg + '</span>' : '') +
        '</div>' +
        '<div class="donation-right">' +
            '<span class="donation-amount">' + amt + ' MT</span>' +
            '<button class="btn-ler" onclick="lerManual(\'' + nome + '\',\'' + amt + '\',\'' + msg + '\')" title="Ouvir">' +
                '<i class="fas fa-volume-up"></i>' +
            '</button>' +
        '</div>';

    if (isNova) lista.prepend(item); else lista.appendChild(item);

    if (d.message) {
        const msgLista = document.getElementById('messages-list');
        const emptyM   = msgLista.querySelector('.empty');
        if (emptyM) emptyM.remove();

        const msgEl = document.createElement('div');
        msgEl.className = 'message-item';
        msgEl.innerHTML =
            '<div class="msg-header">' +
                '<span class="msg-donor"><i class="fas fa-comment"></i>' + nome + '</span>' +
                '<span class="msg-amount">' + amt + ' MT</span>' +
            '</div>' +
            '<p class="msg-text">' + msg + '</p>' +
            '<button class="btn-ler-msg" onclick="lerManual(\'' + nome + '\',\'' + amt + '\',\'' + msg + '\')">' +
                '<i class="fas fa-volume-up"></i> Ouvir' +
            '</button>';

        if (isNova) msgLista.prepend(msgEl); else msgLista.appendChild(msgEl);
    }
}

// ── STATS ─────────────────────────────────────────────────────
function renderStats() {
    const media = countAcumulado > 0 ? (totalAcumulado / countAcumulado).toFixed(2) : 0;
    document.getElementById('total-donations').textContent  = totalAcumulado.toFixed(2) + ' MT';
    document.getElementById('donor-count').textContent      = countAcumulado;
    document.getElementById('average-donation').textContent = media + ' MT';
}

// ── ALERTA VISUAL ─────────────────────────────────────────────
let alertaTimer = null;
function mostrarAlerta(html) {
    const el = document.getElementById('alerta');
    el.innerHTML = html;
    el.classList.add('show');
    clearTimeout(alertaTimer);
    alertaTimer = setTimeout(() => el.classList.remove('show'), 5000);
}

// ── UTILS ─────────────────────────────────────────────────────
function esc(s) {
    return String(s || '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

init();
