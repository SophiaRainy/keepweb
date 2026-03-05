/**
 * Keep Alive - 智能后台保活
 * 
 * 只在 AI 正在生成回复时才启动保活，生成完毕自动释放
 * 不浪费任何后台资源
 */

import { saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const extensionName = 'SillyTavern-KeepAlive';
const defaultSettings = {
    enabled: true,
    useWorker: true,
    useAudio: true,
    useLocks: true,
    useWakeLock: true,
};

let worker = null;
let audioCtx = null;
let audioSource = null;
let wakeLock = null;
let lockHeld = false;

let isAlive = false;          // 保活是否正在运行
let isGenerating = false;     // AI 是否正在生成
let checkTimer = null;        // 检测生成状态的定时器
let heartbeatCount = 0;

// ==============================================
// 检测 AI 是否正在生成
// ==============================================
function checkIsGenerating() {
    // 方法1: 停止按钮可见 = 正在生成
    const stopBtn = document.getElementById('mes_stop');
    if (stopBtn && stopBtn.offsetParent !== null) return true;

    // 方法2: 发送按钮区域的状态
    const sendBtn = document.getElementById('send_but');
    if (sendBtn && sendBtn.style.display === 'none') return true;

    return false;
}

// ==============================================
// 状态监控 — 每秒检测一次生成状态
// ==============================================
function startMonitor() {
    if (checkTimer) return;

    checkTimer = setInterval(() => {
        if (!getSettings().enabled) return;

        const generating = checkIsGenerating();

        if (generating && !isGenerating) {
            // 刚开始生成 → 启动保活
            isGenerating = true;
            activateKeepAlive();
            log('✏️ 检测到 AI 开始生成 → 保活已激活');
        }

        if (!generating && isGenerating) {
            // 生成结束 → 释放保活
            isGenerating = false;
            deactivateKeepAlive();
            log('✅ AI 生成完毕 → 保活已释放');
        }

    }, 1000);
}

function stopMonitor() {
    if (checkTimer) {
        clearInterval(checkTimer);
        checkTimer = null;
    }
}

// ==============================================
// 激活保活（仅在生成时）
// ==============================================
function activateKeepAlive() {
    if (isAlive) return;
    isAlive = true;

    const s = getSettings();
    if (s.useWorker) startWorkerHeartbeat();
    if (s.useAudio) startSilentAudio();
    if (s.useLocks) acquireWebLock();
    if (s.useWakeLock) requestWakeLock();

    updateStatus('🟢 保活中 (AI生成中...)', true);
}

// ==============================================
// 释放保活（生成结束时）
// ==============================================
function deactivateKeepAlive() {
    if (!isAlive) return;
    isAlive = false;

    stopWorkerHeartbeat();
    stopSilentAudio();
    releaseWakeLock();
    lockHeld = false;
    heartbeatCount = 0;

    updateStatus('💤 待机中 (等待AI生成)', false);
}

// ==============================================
// 手段 1: Web Worker 心跳
// ==============================================
function startWorkerHeartbeat() {
    if (worker) return;
    try {
        const code = `
            let iv = null;
            self.onmessage = function(e) {
                if (e.data === 'start') {
                    if (iv) clearInterval(iv);
                    iv = setInterval(() => self.postMessage('hb'), 1000);
                } else if (e.data === 'stop') {
                    if (iv) clearInterval(iv);
                    iv = null;
                }
            };
        `;
        const blob = new Blob([code], { type: 'application/javascript' });
        worker = new Worker(URL.createObjectURL(blob));
        worker.onmessage = () => {
            heartbeatCount++;
            const el = document.getElementById('ka-hb');
            if (el) el.textContent = heartbeatCount;
        };
        worker.postMessage('start');
    } catch (e) {
        console.warn('[KeepAlive] Worker 不可用:', e);
    }
}

function stopWorkerHeartbeat() {
    if (worker) {
        worker.postMessage('stop');
        worker.terminate();
        worker = null;
    }
}

// ==============================================
// 手段 2: 静音音频
// ==============================================
function startSilentAudio() {
    if (audioCtx) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.setValueAtTime(1, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        audioSource = osc;
    } catch (e) {
        console.warn('[KeepAlive] Audio 不可用:', e);
    }
}

function stopSilentAudio() {
    try {
        if (audioSource) { audioSource.stop(); audioSource = null; }
        if (audioCtx) { audioCtx.close(); audioCtx = null; }
    } catch (e) { }
}

// ==============================================
// 手段 3: Web Locks
// ==============================================
function acquireWebLock() {
    if (lockHeld || !navigator.locks) return;
    try {
        navigator.locks.request('st-keep-alive-' + Date.now(), { mode: 'exclusive' }, () => {
            lockHeld = true;
            return new Promise((resolve) => {
                // 保存 resolve，释放时调用
                window._kaLockResolve = resolve;
            });
        });
    } catch (e) { }
}

function releaseWebLock() {
    if (window._kaLockResolve) {
        window._kaLockResolve();
        window._kaLockResolve = null;
    }
    lockHeld = false;
}

// ==============================================
// 手段 4: Screen Wake Lock
// ==============================================
async function requestWakeLock() {
    if (wakeLock || !('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
            wakeLock = null;
            // 如果还在生成中，自动重新获取
            if (isAlive && getSettings().useWakeLock) {
                setTimeout(requestWakeLock, 1000);
            }
        });
    } catch (e) { }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release();
        wakeLock = null;
    }
}

// ==============================================
// Visibility 恢复
// ==============================================
function setupVisibilityListener() {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            // 切回前台
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
            if (isAlive && getSettings().useWakeLock) {
                requestWakeLock();
            }
        }
    });
}

// ==============================================
// 工具
// ==============================================
function getSettings() {
    return extension_settings[extensionName] || defaultSettings;
}

function log(msg) {
    console.log(`[KeepAlive] ${msg}`);
    const el = document.getElementById('ka-log');
    if (el) {
        const time = new Date().toLocaleTimeString('zh-CN');
        el.innerHTML = `<div>[${time}] ${msg}</div>` + el.innerHTML;
        // 最多保留 10 条
        while (el.children.length > 10) el.removeChild(el.lastChild);
    }
}

function updateStatus(text, active) {
    const el = document.getElementById('ka-status-text');
    if (el) {
        el.textContent = text;
        el.className = active ? 'ka-active' : 'ka-idle';
    }
    const dot = document.getElementById('ka-dot');
    if (dot) {
        dot.style.background = active ? '#4CAF50' : '#999';
        dot.style.animationPlayState = active ? 'running' : 'paused';
    }
}

// ==============================================
// 加载设置
// ==============================================
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extension_settings[extensionName][key] === undefined) {
            extension_settings[extensionName][key] = value;
        }
    }
    const s = getSettings();
    $('#ka-enabled').prop('checked', s.enabled);
    $('#ka-use-worker').prop('checked', s.useWorker);
    $('#ka-use-audio').prop('checked', s.useAudio);
    $('#ka-use-locks').prop('checked', s.useLocks);
    $('#ka-use-wakelock').prop('checked', s.useWakeLock);
}

// ==============================================
// 初始化 UI
// ==============================================
jQuery(async () => {
    const html = `
    <div id="keep-alive-panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>💓 智能后台保活</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="display:flex;flex-direction:column;gap:6px;padding:5px 0;">

                <div style="display:flex;align-items:center;gap:8px;">
                    <input id="ka-enabled" type="checkbox" />
                    <label for="ka-enabled"><b>启用智能保活</b></label>
                </div>

                <small style="opacity:0.5;padding:2px 0;">
                    ⚡ 仅在 AI 回复时自动激活，回复完毕立即释放
                </small>

                <hr style="margin:2px 0;border-color:var(--SmartThemeBorderColor);" />
                <small style="opacity:0.6;">保活手段：</small>

                <div style="display:flex;align-items:center;gap:8px;font-size:13px;">
                    <input id="ka-use-worker" type="checkbox" />
                    <label>Worker 心跳 <small style="opacity:0.4;">(核心)</small></label>
                </div>
                <div style="display:flex;align-items:center;gap:8px;font-size:13px;">
                    <input id="ka-use-audio" type="checkbox" />
                    <label>静音音频 <small style="opacity:0.4;">(防冻结)</small></label>
                </div>
                <div style="display:flex;align-items:center;gap:8px;font-size:13px;">
                    <input id="ka-use-locks" type="checkbox" />
                    <label>Web Locks <small style="opacity:0.4;">(防暂停)</small></label>
                </div>
                <div style="display:flex;align-items:center;gap:8px;font-size:13px;">
                    <input id="ka-use-wakelock" type="checkbox" />
                    <label>屏幕唤醒锁 <small style="opacity:0.4;">(平板推荐)</small></label>
                </div>

                <div style="margin-top:6px;padding:8px;border-radius:5px;background:var(--SmartThemeBlurTintColor);font-size:13px;">
                    <span id="ka-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#999;margin-right:4px;animation:ka-pulse 2s ease-in-out infinite;animation-play-state:paused;"></span>
                    <span id="ka-status-text" class="ka-idle">💤 待机中</span>
                    <span style="float:right;opacity:0.4;font-size:11px;">
                        心跳 #<span id="ka-hb">0</span>
                    </span>
                </div>

                <div id="ka-log" style="max-height:80px;overflow-y:auto;font-size:11px;opacity:0.6;padding:4px;background:rgba(0,0,0,0.05);border-radius:3px;"></div>

            </div>
        </div>
    </div>`;

    $('#extensions_settings').append(html);
    loadSettings();

    // ===== 开关事件 =====
    $('#ka-enabled').on('change', function () {
        const enabled = $(this).prop('checked');
        extension_settings[extensionName].enabled = enabled;
        saveSettingsDebounced();

        if (enabled) {
            startMonitor();
            updateStatus('💤 待机中 (等待AI生成)', false);
            log('✅ 智能保活已启用 — 等待 AI 生成时自动激活');
            toastr.success('智能保活已启用');
        } else {
            stopMonitor();
            deactivateKeepAlive();
            isGenerating = false;
            updateStatus('已关闭', false);
            log('⏸ 智能保活已关闭');
            toastr.info('智能保活已关闭');
        }
    });

    // 子开关
    ['worker', 'audio', 'locks', 'wakelock'].forEach(key => {
        $(`#ka-use-${key}`).on('change', function () {
            const map = { worker: 'useWorker', audio: 'useAudio', locks: 'useLocks', wakelock: 'useWakeLock' };
            extension_settings[extensionName][map[key]] = $(this).prop('checked');
            saveSettingsDebounced();
        });
    });

    // ===== 监听 visibility =====
    setupVisibilityListener();

    // ===== 自动启动监控 =====
    if (getSettings().enabled) {
        setTimeout(() => {
            startMonitor();
            updateStatus('💤 待机中 (等待AI生成)', false);
            log('插件已加载 — 等待 AI 生成');
        }, 2000);
    }

    console.log('[KeepAlive] ✅ 插件加载完成');
});
