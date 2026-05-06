// ============================================================
//  GUIFT - DOAÇÃO
//
//  BUGS CORRIGIDOS:
//  1. window._db pode ser undefined → verificação explícita
//  2. Streamer não encontrado sem logs → debug detalhado
//  3. Busca case-insensitive e por partes do nome
//  4. RLS pode bloquear leitura de profiles → loga exactamente
//  5. Sem validação de UUID do streamer_id → verificado
// ============================================================

let carteiraSelecionada = null;

// FIX: Verifica se _db está disponível antes de usar
function getDB() {
    if (!window._db) {
        GUIFT_ERR('DOAR', 'window._db não está disponível! Verifica a ordem dos scripts.');
        throw new Error('Base de dados não inicializada. Recarrega a página.');
    }
    return window._db;
}

window.addEventListener('DOMContentLoaded', () => {
    // Pré-preenche nome do streamer via URL
    const params   = new URLSearchParams(window.location.search);
    const username = params.get('streamer');
    if (username) {
        GUIFT_LOG('DOAR', 'Streamer pré-preenchido via URL:', username);
        const campo    = document.getElementById('streamer-id');
        campo.value    = username;
        campo.readOnly = true;
        campo.style.opacity = '0.6';
    }
});

window.selecionarCarteira = function(carteira, btn) {
    carteiraSelecionada = carteira;
    document.querySelectorAll('.wallet-buttons button').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    const p = document.getElementById('phone');
    p.placeholder = carteira === 'mpesa' ? 'M-Pesa: 84/85xxxxxxx' : 'eMola: 86/87xxxxxxx';
    GUIFT_LOG('DOAR', 'Carteira seleccionada:', carteira);
};

function validarTelefone(n, carteira) {
    const num = n.replace(/[\s\-]/g, '');
    if (!/^\d{9}$/.test(num)) return { ok: false, msg: 'Número deve ter 9 dígitos.' };
    const pref = parseInt(num.substring(0, 2));
    if (carteira === 'mpesa' && pref !== 84 && pref !== 85)
        return { ok: false, msg: 'M-Pesa aceita só números 84 ou 85.' };
    if (carteira === 'emola' && pref !== 86 && pref !== 87)
        return { ok: false, msg: 'eMola aceita só números 86 ou 87.' };
    return { ok: true };
}

function toast(msg, tipo) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className   = 'toast show ' + (tipo || 'info');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('show'), 4000);
}

// ── BUSCAR STREAMER ──────────────────────────────────────────
// FIX: Busca robusta com múltiplas estratégias e logs detalhados
async function buscarStreamer(nomeInput) {
    const db = getDB();

    GUIFT_LOG('DOAR', '🔍 A buscar streamer:', nomeInput);

    // Estratégia 1: match exacto (case-insensitive)
    GUIFT_LOG('DOAR', 'Tentativa 1: match exacto...');
    const { data: exacto, error: err1 } = await db
        .from('profiles')
        .select('id, name, email')
        .ilike('name', nomeInput)
        .limit(1);

    if (err1) {
        GUIFT_ERR('DOAR', 'Erro na busca exacta (verifica RLS da tabela profiles)', err1);
        // FIX: Se RLS bloqueia, informar claramente
        if (err1.code === '42501') {
            throw new Error('Permissão negada ao ler perfis. O administrador precisa de configurar o Supabase (ver SUPABASE_SETUP.sql).');
        }
        throw err1;
    }

    GUIFT_LOG('DOAR', 'Resultado match exacto:', exacto);

    if (exacto && exacto.length > 0) {
        GUIFT_LOG('DOAR', '✅ Streamer encontrado (exacto):', exacto[0]);
        return exacto[0];
    }

    // Estratégia 2: match parcial
    GUIFT_LOG('DOAR', 'Tentativa 2: match parcial...');
    const { data: parcial, error: err2 } = await db
        .from('profiles')
        .select('id, name, email')
        .ilike('name', '%' + nomeInput + '%')
        .limit(5);

    if (err2) {
        GUIFT_ERR('DOAR', 'Erro na busca parcial', err2);
        throw err2;
    }

    GUIFT_LOG('DOAR', 'Resultado match parcial:', parcial);

    if (parcial && parcial.length > 0) {
        // Prefere o mais parecido
        const melhor = parcial.find(
            p => p.name.toLowerCase() === nomeInput.toLowerCase()
        ) || parcial[0];
        GUIFT_LOG('DOAR', '✅ Streamer encontrado (parcial):', melhor);
        return melhor;
    }

    // Estratégia 3: debug — lista todos os perfis para ver o que existe
    GUIFT_LOG('DOAR', 'Tentativa 3: a listar todos os perfis para debug...');
    const { data: todos, error: err3 } = await db
        .from('profiles')
        .select('id, name, email')
        .limit(20);

    if (err3) {
        GUIFT_ERR('DOAR', 'Erro ao listar perfis', err3);
    } else {
        GUIFT_LOG('DOAR', 'Perfis existentes na BD:', todos);
        if (!todos || todos.length === 0) {
            GUIFT_ERR('DOAR',
                'A tabela profiles está VAZIA! ' +
                'Corre o ficheiro SUPABASE_SETUP.sql no Supabase SQL Editor.'
            );
        }
    }

    // Não encontrado
    return null;
}

// ── ENVIAR DOAÇÃO ────────────────────────────────────────────
window.enviarDoacao = async function() {
    const nomeStreamer = document.getElementById('streamer-id').value.trim();
    const donorName    = document.getElementById('donor-name').value.trim();
    const amount       = parseFloat(document.getElementById('amount').value);
    const message      = document.getElementById('message').value.trim();
    const phone        = document.getElementById('phone').value.replace(/[\s\-]/g, '');

    // Validações
    if (!nomeStreamer)                           { toast('⚠️ Introduz o nome do streamer.', 'warn'); return; }
    if (!donorName)                              { toast('⚠️ Introduz o teu nome.', 'warn'); return; }
    if (!amount || isNaN(amount) || amount < 10) { toast('⚠️ Valor mínimo é 10 MT.', 'warn'); return; }
    if (!carteiraSelecionada)                    { toast('⚠️ Seleciona M-Pesa ou eMola.', 'warn'); return; }
    if (!phone)                                  { toast('⚠️ Introduz o teu número.', 'warn'); return; }

    const tv = validarTelefone(phone, carteiraSelecionada);
    if (!tv.ok) { toast('❌ ' + tv.msg, 'error'); return; }

    const btn = document.getElementById('btn-doar');
    btn.disabled = true; btn.textContent = 'A processar...';

    try {
        const db = getDB();

        // Buscar streamer com debug detalhado
        const perfil = await buscarStreamer(nomeStreamer);

        if (!perfil) {
            GUIFT_ERR('DOAR',
                'Streamer "' + nomeStreamer + '" não encontrado. ' +
                'Verifica se o nome está correcto e se o utilizador existe na tabela profiles.'
            );
            toast(
                '❌ Streamer "' + nomeStreamer + '" não encontrado.\n' +
                'Verifica o nome exacto usado no registo.',
                'error'
            );
            return;
        }

        // FIX: Validar UUID antes de inserir
        if (!perfil.id || typeof perfil.id !== 'string' || perfil.id.length !== 36) {
            GUIFT_ERR('DOAR', 'ID do streamer inválido:', perfil.id);
            toast('❌ Erro interno: ID do streamer inválido.', 'error');
            return;
        }

        GUIFT_LOG('DOAR', 'A inserir doação...', {
            streamer_id:    perfil.id,
            donor_name:     donorName,
            amount:         amount,
            payment_method: carteiraSelecionada
        });

        const { error: erroInsert } = await db.from('donations').insert([{
            streamer_id:    perfil.id,
            donor_name:     donorName,
            amount:         amount,
            message:        message || null,
            phone:          phone,
            payment_method: carteiraSelecionada
        }]);

        if (erroInsert) {
            // FIX: Logs específicos por tipo de erro
            if (erroInsert.code === '42501') {
                GUIFT_ERR('DOAR', 'RLS bloqueou insert em donations. Verifica as policies.', erroInsert);
                throw new Error('Permissão negada ao enviar doação. Contacta o administrador.');
            }
            if (erroInsert.code === '23503') {
                GUIFT_ERR('DOAR', 'streamer_id não existe na tabela profiles.', erroInsert);
                throw new Error('Streamer não existe na base de dados.');
            }
            throw erroInsert;
        }

        GUIFT_LOG('DOAR', '✅ Doação inserida com sucesso!');

        const metodo = carteiraSelecionada === 'mpesa' ? 'M-Pesa' : 'eMola';
        toast('✅ ' + amount + ' MT via ' + metodo + ' para ' + perfil.name + '! Obrigado!', 'success');

        // Limpar formulário
        document.getElementById('donor-name').value = '';
        document.getElementById('amount').value     = '';
        document.getElementById('message').value    = '';
        document.getElementById('phone').value      = '';
        carteiraSelecionada = null;
        document.querySelectorAll('.wallet-buttons button').forEach(b => b.classList.remove('selected'));

    } catch (err) {
        GUIFT_ERR('DOAR', 'Erro ao enviar doação', err);
        toast('❌ ' + (err.message || 'Erro desconhecido'), 'error');
    } finally {
        btn.disabled = false; btn.textContent = 'ENVIAR DOAÇÃO';
    }
};
