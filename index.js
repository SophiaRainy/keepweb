/**
 * Keep Alive v2 - 智能后台保活（最终版）
 * 
 * 设计思路：
 * - Worker 心跳永远开着（极低消耗，但防止主线程冻结）
 * - 音频/WakeLock 只在 AI 生成时开启（省资源）
 * - 由 Worker 驱动检测，不依赖主线程 setInterval
 */

import { saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';

const extensionName = 'SillyTavern-KeepAlive';
const defaultSettings = {
    enabled: true,
    useAudio: true,
    useWakeLock: true,
    useLocks: true,
};

// ============ 状态 ============
let worker = null;
let audioCtx = null;
let audioSource = null;
let wakeLock = null;
let lockResolve = null;

let isGenerating = false;   // AI 是否正在生成
let boostActive = false;    // 重资源保活是否激活
let heartbeatCount = 0;

// ============================================
// Worker：永远运行，每秒发心跳
// 这是整个插件的"心脏"，它不受后台冻结影响
// 每次收到心跳就检查一次 AI 生成状态
// ============================================
function startWorker() {
    if (worker) return;

    const code = `
        let iv = null;
        self.onmessage = function(e) {
            if (e.data === 'start') {
                if (iv) clearInterval(iv);
                iv = setInterval(() => self.postMessage('tick'), 1000);
            }
            if (e.data === 'stop') {
                if (iv) clearInterval(iv);
                iv = null;
            }
        };
    `;

    try {
        const blob = new Blob([code], { type: 'application/javascript' });
        worker = new Worker(URL.createObjectURL(blob));

        worker.onmessage = function () {
            heartbeatCount++;
            // Worker 每秒触发一次，由它来驱动主线程检测
            onTick();
        };

        worker.postMessage('start');
        log('✅ Worker 心跳已启动（常驻）');
    } catch (e) {
        console.warn('[KeepAlive] Worker 创建失败:', e);
        // Worker 不可用时 fallback 到 setInterval
        setInterval(onTick, 1000);
        log('⚠️ Worker 不可用，使用 fallback');
    }
}

function stopWorker() {
    if (worker) {
        worker.postMessage('stop');
        worker.terminate();
        worker = null;
    }
}

// ============================================
// 每秒被 Worker 调用：检测 AI 是否在生成
// ============================================
function onTick() {
    if (!getSettings().enabled) return;

    // 更新心跳 UI
    const hbEl = document.getElementById('ka-hb');
    if (hbEl) hbEl.textContent = heartbeatCount;

    // 检测 AI 是否在生成
    const nowGenerating = checkIsGenerating();

    if (nowGenerating && !isGenerating) {
        // === 刚开始生成 → 启动重资源保活 ===
        isGenerating = true;
        activateBoost();
        log('✏️ AI 开始生成 → 全力保活');
    }

    if (!nowGenerating && isGenerating) {
        // === 生成结束 → 释放重资源 ===
        isGenerating = false;
        deactivateBoost();
        log('✅ AI 生成完毕 → 仅保留心跳');
    }
}

// ============================================
// 检测 AI 是否正在生成
// ============================================
function checkIsGenerating() {
    // 停止按钮可见
    const stopBtn = document.getElementById('mes_stop');
    if (stopBtn) {
        const style = window.getComputedStyle(stopBtn);
        if (style.display !== 'none' && stopBtn.offsetParent !== null) {
            return true;
        }
    }

    // send_but 被隐藏（正在生成时酒馆会隐藏发送按钮）
    const sendBtn = document.getElementById('send_but');
    if (sendBtn) {
        const style = window.getComputedStyle(sendBtn);
        if (style.display === 'none' || style.visibility === 'hidden') {
            return true;
        }
    }

    return false;
}

// ============================================
// 重资源保活：音频 + WakeLock + Locks
// 只在 AI 生成时激活
// ============================================
function activateBoost() {
    if (boostActive) return;
    boostActive = true;

    const s = getSettings();
    if (s.useAudio) startAudio();
    if (s.useWakeLock) requestWakeLock();
    if (s.useLocks) acquireLock();

    updateStatus('🟢 全力保活中 (AI生成中)', 'ka-active');
}

function deactivateBoost() {
    if (!boostActive) return;
    boostActive = false;

    stopAudio();
    releaseWakeLock();
    releaseLock();

    updateStatus('💙 心跳待机中', 'ka-standby');
}

// ============================================
// 静音音频
// ============================================
function startAudio() {
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
    } catch (e) { }
}

function stopAudio() {
    try {
        if (audioSource) { audioSource.stop(); audioSource = null; }
        if (audioCtx) { audioCtx.close(); audioCtx = null; }
    } catch (e) { }
}

// ============================================
// Screen Wake Lock
// ============================================
async function requestWakeLock() {
    if (wakeLock || !('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => {
            wakeLock = null;
            if (boostActive && getSettings().useWakeLock) {
                setTimeout(requestWakeLock, 1000);
            }
        });
    } catch (e) { }
}

function releaseWakeLock() {
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
}

// ============================================
// Web Locks
// ============================================
function acquireLock() {
    if (lockResolve || !navigator.locks) return;
    try {
        navigator.locks.request('st-keepalive-' + Date.now(), () => {
            return new Promise(resolve => { lockResolve = resolve; });
        });
    } catch (e) { }
}

function releaseLock() {
    if (lockResolve) { lockResolve(); lockResolve = null; }
}

// ============================================
// Visibility 监听
// ============================================
function setupVisibility() {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            log('📱 切回前台');
            // 恢复 AudioContext
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
            // 如果正在生成但 boost 没开，补开
            if (isGenerating && !boostActive) {
                activateBoost();
            }
            if (boostActive && getSettings().useWakeLock) {
                requestWakeLock();
            }
        } else {
            log('📱 切到后台' + (isGenerating ? ' (AI生成中，保活已激活)' : ''));
        }
    });
}

// ============================================
// 工具
// ============================================
function getSettings() {
    return extension_settings[extensionName] || defaultSettings;
}

function log(msg) {
    console.log(`[KeepAlive] ${msg}`);
    const el = document.getElementById('ka-log');
    if (el) {
        const time = new Date().toLocaleTimeString('zh-CN');
        el.innerHTML = `<div>[${time}] ${msg}</div>` + el.innerHTML;
        while (el.children.length > 15) el.removeChild(el.lastChild);
    }
}

function updateStatus(text, cls) {
    const el = document.getElementById('ka-status-text');
    if (el) { el.textContent = text; el.className = cls || ''; }

    const dot = document.getElementById('ka-dot');
    if (dot) {
        if (cls === 'ka-active') {
            dot.style.background = '#4CAF50';
            dot.style.animationPlayState = 'running';
        } else if (cls === 'ka-standby') {
            dot.style.background = '#2196F3';
            dot.style.animationPlayState = 'running';
        } else {
            dot.style.background = '#999';
            dot.style.animationPlayState = 'paused';
        }
    }
}

// ============================================
// 加载设置
// ============================================
function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (extension_settings[extensionName][k] === undefined)
            extension_settings[extensionName][k] = v;
    }
    const s = getSettings();
    $('#ka-enabled').prop('checked', s.enabled);
    $('#ka-use-audio').prop('checked', s.useAudio);
    $('#ka-use-wakelock').prop('checked', s.useWakeLock);
    $('#ka-use-locks').prop('checked', s.useLocks);
}

// ============================================
// 初始化
// ============================================
jQuery(async () => {
    const html = `
    <div id="keep-alive-panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>💓 智能后台保活 v2</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="display:flex;flex-direction:column;gap:6px;padding:5px 0;">

                <div style="display:flex;align-items:center;gap:8px;">
                    <input id="ka-enabled" type="checkbox" />
                    <label for="ka-enabled"><b>启用保活</b></label>
                </div>

                <small style="opacity:0.5;line-height:1.4;">
                    💙 心跳常驻（极低消耗）<br>
                    🟢 AI 生成时自动加强保活<br>
                    ✅ 生成完毕自动释放重资源
                </small>

                <hr style="margin:2px 0;border-color:var(--SmartThemeBorderColor);" />
                <small style="opacity:0.6;">生成时额外启用：</small>

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
                    <span id="ka-status-text" class="ka-idle">未启动</span>
                    <span style="float:right;opacity:0.4;font-size:11px;">
                        #<span id="ka-hb">0</span>
                    </span>
                </div>

                <div id="ka-log" style="max-height:80px;overflow-y:auto;font-size:11px;opacity:0.6;padding:4px;background:rgba(0,0,0,0.05);border-radius:3px;"></div>

            </div>
        </div>
    </div>`;

    $('#extensions_settings').append(html);
    loadSettings();

    // 开关事件
    $('#ka-enabled').on('change', function () {
        const on = $(this).prop('checked');
        extension_settings[extensionName].enabled = on;
        saveSettingsDebounced();
        if (on) {
            startWorker();
            updateStatus('💙 心跳待机中', 'ka-standby');
            log('✅ 保活已启用');
            toastr.success('保活已启用');
        } else {
            stopWorker();
            deactivateBoost();
            isGenerating = false;
            updateStatus('已关闭', '');
            log('⏸ 保活已关闭');
            toastr.info('保活已关闭');
        }
    });

    // 子开关
    const map = { audio: 'useAudio', locks: 'useLocks', wakelock: 'useWakeLock' };
    Object.keys(map).forEach(key => {
        $(`#ka-use-${key}`).on('change', function () {
            extension_settings[extensionName][map[key]] = $(this).prop('checked');
            saveSettingsDebounced();
        });
    });

    // 监听可见性
    setupVisibility();

    // 自动启动
    if (getSettings().enabled) {
        setTimeout(() => {
            startWorker();
            updateStatus('💙 心跳待机中', 'ka-standby');
            log('插件已加载 — Worker 心跳常驻');
        }, 1500);
    }

    console.log('[KeepAlive v2] ✅ 加载完成');
});
