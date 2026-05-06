// ============================================================
//  GUIFT - CONFIGURAÇÃO CENTRAL
// ============================================================

const GUIFT_CONFIG = {
    SUPABASE_URL:      'https://cdlpdnlkkxulwnumzxme.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_SwObjawXRfn0Sen8Y3G94A_sKYK2Zt0',
    SITE_URL:          window.location.origin,
    DEBUG:             true
};

// Logger centralizado — facilita debug sem alterar UI
// Também guarda logs para visualização no mobile (sem console)
let GUIFT_LOGS_BUFFER = [];
const MAX_LOGS = 50;

window.GUIFT_LOG = function(area, msg, data) {
    if (!GUIFT_CONFIG.DEBUG) return;
    const timestamp = new Date().toLocaleTimeString('pt-PT');
    const log = '[' + timestamp + '] [' + area + '] ' + msg + (data ? ' ' + JSON.stringify(data) : '');
    
    // Guardar em memória para mobile
    GUIFT_LOGS_BUFFER.push({ type: 'log', text: log, area: area, time: timestamp });
    if (GUIFT_LOGS_BUFFER.length > MAX_LOGS) GUIFT_LOGS_BUFFER.shift();
    
    // Também enviar para console
    if (data !== undefined) console.log('[GUIFT:' + area + ']', msg, data);
    else                    console.log('[GUIFT:' + area + ']', msg);
    
    // Actualizar painel de debug se existir
    if (window._updateDebugPanel) window._updateDebugPanel();
};

window.GUIFT_ERR = function(area, msg, err) {
    const timestamp = new Date().toLocaleTimeString('pt-PT');
    const log = '[' + timestamp + '] [' + area + '] ❌ ' + msg + (err ? ' ' + JSON.stringify(err) : '');
    
    // Guardar em memória
    GUIFT_LOGS_BUFFER.push({ type: 'error', text: log, area: area, time: timestamp });
    if (GUIFT_LOGS_BUFFER.length > MAX_LOGS) GUIFT_LOGS_BUFFER.shift();
    
    console.error('[GUIFT:' + area + '] ❌ ' + msg, err || '');
    
    // Actualizar painel de debug se existir
    if (window._updateDebugPanel) window._updateDebugPanel();
};
