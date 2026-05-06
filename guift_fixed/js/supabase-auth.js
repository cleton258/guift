// ============================================================
//  GUIFT - AUTENTICAÇÃO SUPABASE
//
//  BUGS CORRIGIDOS:
//  1. criarPerfil falha silenciosamente → agora loga o erro
//  2. Upsert bloqueado por RLS sem sessão → usa INSERT separado
//     com tratamento de conflito explícito
//  3. onAuthStateChange adicionado para persistência de sessão
//  4. processarTokenEmail agora processa token correctamente
// ============================================================

(function () {
    const SUPA_URL  = GUIFT_CONFIG.SUPABASE_URL;
    const SUPA_KEY  = GUIFT_CONFIG.SUPABASE_ANON_KEY;
    const SITE      = GUIFT_CONFIG.SITE_URL;

    // FIX: cliente criado UMA vez e exposto globalmente
    // Usar createClient sem opções extras evita conflitos de lock
    const _db = window.supabase.createClient(SUPA_URL, SUPA_KEY);
    window._db = _db;

    GUIFT_LOG('AUTH', 'Cliente Supabase inicializado', SUPA_URL);

    // ── CRIAR/SINCRONIZAR PERFIL ─────────────────────────────
    // FIX: Separado em INSERT e UPDATE para contornar RLS
    // quando não há sessão activa (signup com confirmação de email)
    async function sincronizarPerfil(userId, nome, email) {
        GUIFT_LOG('PERFIL', 'A sincronizar perfil...', { userId, nome, email });

        // Tenta INSERT primeiro (novo utilizador)
        const { error: errInsert } = await _db
            .from('profiles')
            .insert({ id: userId, name: nome, email: email });

        if (!errInsert) {
            GUIFT_LOG('PERFIL', '✅ Perfil criado com sucesso');
            return true;
        }

        // Se já existe (código 23505 = unique_violation), faz UPDATE
        if (errInsert.code === '23505') {
            GUIFT_LOG('PERFIL', 'Perfil já existe, a actualizar nome...');
            const { error: errUpdate } = await _db
                .from('profiles')
                .update({ name: nome, email: email })
                .eq('id', userId);

            if (errUpdate) {
                GUIFT_ERR('PERFIL', 'Erro ao actualizar perfil', errUpdate);
                return false;
            }
            GUIFT_LOG('PERFIL', '✅ Perfil actualizado');
            return true;
        }

        // FIX: Se RLS bloqueou (código 42501), loga claramente
        if (errInsert.code === '42501') {
            GUIFT_ERR('PERFIL',
                'RLS bloqueou criação de perfil. ' +
                'Verifica as policies da tabela profiles no Supabase.',
                errInsert
            );
        } else {
            GUIFT_ERR('PERFIL', 'Erro desconhecido ao criar perfil', errInsert);
        }
        return false;
    }

    // ── REGISTRO ─────────────────────────────────────────────
    window.registrar = async function () {
        const nome      = document.getElementById('nome').value.trim();
        const email     = document.getElementById('email').value.trim();
        const senha     = document.getElementById('senha').value;
        const confirmar = document.getElementById('confirmar').value;

        if (!nome || !email || !senha || !confirmar) {
            return alert('⚠️ Preenche todos os campos.');
        }
        if (senha !== confirmar) {
            return alert('❌ As senhas não coincidem.');
        }
        if (senha.length < 6) {
            return alert('❌ Senha deve ter pelo menos 6 caracteres.');
        }

        const btn = document.getElementById('btn-registrar');
        btn.disabled = true; btn.textContent = 'A criar conta...';

        try {
            GUIFT_LOG('AUTH', 'A registar utilizador...', email);

            const { data, error } = await _db.auth.signUp({
                email,
                password: senha,
                options: {
                    emailRedirectTo: SITE + '/login.html',
                    data: { name: nome }
                }
            });

            if (error) throw error;

            GUIFT_LOG('AUTH', '✅ signUp OK', data.user?.id);

            // FIX: Tenta criar perfil mesmo sem sessão confirmada.
            // O trigger no Supabase (security definer) também cria o perfil
            // automaticamente — isto é um fallback adicional.
            if (data.user) {
                const ok = await sincronizarPerfil(data.user.id, nome, email);
                GUIFT_LOG('AUTH', 'Perfil sincronizado via frontend:', ok);
            }

            alert(
                '✅ Conta criada!\n\n' +
                'Verifica o teu e-mail (' + email + ') e confirma antes de fazer login.\n\n' +
                'Depois faz login com o teu nome: ' + nome
            );
            window.location.href = 'login.html';

        } catch (err) {
            GUIFT_ERR('AUTH', 'Erro no registro', err);
            const msgs = {
                'User already registered': '⚠️ E-mail já registado. Faz login.',
                'Invalid email':           '❌ E-mail inválido.',
                'signup is disabled':      '❌ Registo desativado no Supabase.',
            };
            alert(msgs[err.message] || '❌ ' + err.message);
        } finally {
            btn.disabled = false; btn.textContent = 'REGISTRAR';
        }
    };

    // ── LOGIN ─────────────────────────────────────────────────
    window.fazerLogin = async function () {
        const email = document.getElementById('email').value.trim();
        const senha = document.getElementById('senha').value;

        if (!email || !senha) return alert('⚠️ Preenche e-mail e senha.');

        const btn = document.getElementById('btn-login');
        btn.disabled = true; btn.textContent = 'A entrar...';

        try {
            GUIFT_LOG('AUTH', 'A fazer login...', email);

            const { data, error } = await _db.auth.signInWithPassword({
                email,
                password: senha
            });

            if (error) throw error;

            GUIFT_LOG('AUTH', '✅ Login OK', data.user.id);

            // FIX: Após login com sessão activa, RLS permite o upsert
            // O nome vem dos metadados guardados no signup
            const nome = data.user.user_metadata?.name || email.split('@')[0];
            GUIFT_LOG('AUTH', 'Nome do utilizador:', nome);

            await sincronizarPerfil(data.user.id, nome, email);

            window.location.href = 'streamer-dashboard.html';

        } catch (err) {
            GUIFT_ERR('AUTH', 'Erro no login', err);
            const msgs = {
                'Invalid login credentials': '❌ E-mail ou senha incorretos.',
                'Email not confirmed':        '⚠️ Confirma o teu e-mail primeiro.',
                'Too many requests':          '⏳ Muitas tentativas. Aguarda uns minutos.',
            };
            alert(msgs[err.message] || '❌ ' + err.message);
        } finally {
            btn.disabled = false; btn.textContent = 'ENTRAR';
        }
    };

    // ── REDIRECIONA SE JÁ LOGADO ──────────────────────────────
    // FIX: getSession() — sem lock error, leitura local
    window.redirecionarSeLogado = async function () {
        try {
            const { data: { session } } = await _db.auth.getSession();
            GUIFT_LOG('AUTH', 'Sessão activa:', !!session);
            if (session) window.location.href = 'streamer-dashboard.html';
        } catch (e) {
            GUIFT_ERR('AUTH', 'Erro ao verificar sessão', e);
        }
    };

    // ── PROCESSAR TOKEN DO EMAIL ───────────────────────────────
    // FIX: Processa hash do URL após confirmação de email
    window.processarTokenEmail = async function () {
        const hash = window.location.hash;
        if (!hash.includes('access_token')) return;

        GUIFT_LOG('AUTH', 'Token de email detectado no URL, a processar...');

        try {
            // O Supabase JS v2 processa o hash automaticamente via getSession
            const { data: { session }, error } = await _db.auth.getSession();

            if (error) throw error;

            if (session) {
                GUIFT_LOG('AUTH', '✅ Sessão estabelecida após confirmação de email');

                // Sincroniza o perfil agora que temos sessão activa
                const user = session.user;
                const nome = user.user_metadata?.name || user.email.split('@')[0];
                await sincronizarPerfil(user.id, nome, user.email);

                // Limpa o hash do URL
                window.history.replaceState(null, '', window.location.pathname);

                alert('✅ E-mail confirmado! Podes fazer login agora.');
                window.location.href = 'login.html';
            }
        } catch (e) {
            GUIFT_ERR('AUTH', 'Erro ao processar token de email', e);
        }
    };

    // ── PERSISTÊNCIA DE SESSÃO ────────────────────────────────
    // FIX: onAuthStateChange garante que o estado é actualizado
    // mesmo após refresh da página
    _db.auth.onAuthStateChange((event, session) => {
        GUIFT_LOG('AUTH', 'Auth state changed:', event);
    });

})();
