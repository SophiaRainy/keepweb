/**
 * Keep Alive - 后台保活插件
 * 
 * 防止浏览器后台标签页冻结，确保流式输出不中断
 * 
 * 使用 5 种手段同时保活：
 * 1. Web Worker 心跳 — Worker 线程不受标签页冻结影响
 * 2. Web Locks API — 持有锁让浏览器认为页面在做重要工作
 * 3. 无声音频循环 — 播放静音音频，阻止浏览器暂停页面
 * 4. Screen Wake Lock — 请求屏幕唤醒锁（防止屏幕关闭冻结）
 * 5. Visibility 恢复 — 页面恢复前台时自动重连检查
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
    showHeartbeat: true,
};

let worker = null;
let audioCtx = null;
let audioSource = null;
let wakeLock = null;
let lockHeld = false;
let heartbeatCount = 0;
let heartbeatTimer = null;

// ==========================================
// 手段 1: Web Worker 心跳
// Worker 线程不受后台节流影响
// ==========================================
function startWorkerHeartbeat() {
    if (worker) return;

    try {
        const workerCode = `
            let interval = null;
            self.onmessage = function(e) {
                if (e.data === 'start') {
                    if (interval) clearInterval(interval);
                    interval = setInterval(() => {
                        self.postMessage('heartbeat');
                    }, 1000);
                } else if (e.data === 'stop') {
                    if (interval) clearInterval(interval);
                    interval = null;
                }
            };
        `;

        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        worker = new Worker(url);

        worker.onmessage = function (e) {
            if (e.data === 'heartbeat') {
                heartbeatCount++;
                onHeartbeat();
            }
        };

        worker.postMessage('start');
        console.log('[KeepAlive] ✅ Web Worker 心跳已启动');
    } catch (e) {
        console.warn('[KeepAlive] Web Worker 不可用:', e.message);
    }
}

function stopWorkerHeartbeat() {
    if (worker) {
        worker.postMessage('stop');
        worker.terminate();
        worker = null;
    }
}

// ==========================================
// 手段 2: Web Locks API
// 持有一个锁让浏览器不冻结页面
// ==========================================
function acquireWebLock() {
    if (lockHeld) return;

    if (navigator.locks) {
        try {
            navigator.locks.request('sillytavern-keep-alive', { mode: 'exclusive' }, () => {
                lockHeld = true;
                console.log('[KeepAlive] ✅ Web Lock 已获取');
                // 返回一个永远不 resolve 的 Promise，保持锁
                return new Promise(() => { });
            });
        } catch (e) {
            console.warn('[KeepAlive] Web Locks 不可用:', e.message);
        }
    }
}

// ==========================================
// 手段 3: 无声音频循环
// 播放静音音频让浏览器认为页面在"使用中"
// ==========================================
function startSilentAudio() {
    if (audioCtx) return;

    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        // 创建一个几乎无声的振荡器 (音量极低)
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(1, audioCtx.currentTime); // 1Hz，人耳听不到

        gainNode.gain.setValueAtTime(0.001, audioCtx.currentTime); // 几乎静音

        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        oscillator.start();

        audioSource = oscillator;
        console.log('[KeepAlive] ✅ 静音音频已启动');
    } catch (e) {
        console.warn('[KeepAlive] Audio 不可用:', e.message);
    }
}

function stopSilentAudio() {
    try {
        if (audioSource) {
            audioSource.stop();
            audioSource = null;
        }
        if (audioCtx) {
            audioCtx.close();
            audioCtx = null;
        }
    } catch (e) { }
}

// ==========================================
// 手段 4: Screen Wake Lock
// 请求屏幕保持亮起（防止平板灭屏冻结）
// ==========================================
async function requestWakeLock() {
    if (wakeLock) return;

    if ('wakeLock' in navigator) {
        try {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('[KeepAlive] ✅ Screen Wake Lock 已获取');

            wakeLock.addEventListener('release', () => {
                console.log('[KeepAlive] Wake Lock 被释放');
                wakeLock = null;
                // 自动尝试重新获取
                if (getSettings().enabled && getSettings().useWakeLock) {
                    setTimeout(requestWakeLock, 1000);
                }
            });
        } catch (e) {
            console.warn('[KeepAlive] Wake Lock 不可用:', e.message);
        }
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release();
        wakeLock = null;
    }
}

// ==========================================
// 手段 5: Visibility 变化监听
// 页面恢复前台时进行恢复检查
// ==========================================
function setupVisibilityListener() {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            console.log('[KeepAlive] 📱 页面恢复前台');
            updateStatus('页面已恢复前台');

            // 恢复 AudioContext (Chrome 要求用户交互后才能播放)
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume();
            }

            // 重新获取 Wake Lock
            if (getSettings().useWakeLock) {
                requestWakeLock();
            }
        } else {
            console.log('[KeepAlive] 📱 页面进入后台');
            updateStatus('后台运行中...');
        }
    });

    // 页面冻结前的最后机会
    document.addEventListener('freeze', () => {
        console.warn('[KeepAlive] ⚠️ 页面即将被冻结!');
    });

    document.addEventListener('resume', () => {
        console.log('[KeepAlive] 页面从冻结中恢复');
        // 重新启动所有保活手段
        startAll();
    });
}

// ==========================================
// 心跳回调 & 状态更新
// ==========================================
function onHeartbeat() {
    if (!getSettings().showHeartbeat) return;

    const el = document.getElementById('ka-heartbeat-count');
    if (el) {
        el.textContent = heartbeatCount;
    }

    // 每 30 次心跳更新一下状态
    if (heartbeatCount % 30 === 0) {
        const bg = document.visibilityState === 'hidden' ? '后台' : '前台';
        updateStatus(`运行中 [${bg}] - 心跳 #${heartbeatCount}`);
    }
}

function updateStatus(text) {
    const el = document.getElementById('ka-status-text');
    if (el) el.textContent = text;
}

function getSettings() {
    return extension_settings[extensionName] || defaultSettings;
}

// ==========================================
// 全部启动 / 停止
// ==========================================
function startAll() {
    const s = getSettings();
    if (!s.enabled) return;

    if (s.useWorker) startWorkerHeartbeat();
    if (s.useLocks) acquireWebLock();
    if (s.useAudio) startSilentAudio();
    if (s.useWakeLock) requestWakeLock();

    updateStatus('🟢 保活运行中');
    console.log('[KeepAlive] 全部保活手段已启动');
}

function stopAll() {
    stopWorkerHeartbeat();
    stopSilentAudio();
    releaseWakeLock();
    lockHeld = false;
    heartbeatCount = 0;

    updateStatus('已停止');
    console.log('[KeepAlive] 全部保活已停止');
}

// ==========================================
// 加载设置
// ==========================================
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
    $('#ka-show-heartbeat').prop('checked', s.showHeartbeat);
}

// ==========================================
// 初始化 UI
// ==========================================
jQuery(async () => {
    const html = `
    <div id="keep-alive-panel">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>💓 后台保活 (Keep Alive)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <div class="ka-row">
                    <input id="ka-enabled" type="checkbox" />
                    <label for="ka-enabled"><b>启用后台保活</b></label>
                </div>

                <hr style="margin: 4px 0; border-color: var(--SmartThemeBorderColor);" />
                <small style="opacity:0.6;">保活手段（建议全开）：</small>

                <div class="ka-row">
                    <input id="ka-use-worker" type="checkbox" />
                    <label>Web Worker 心跳</label>
                    <small style="opacity:0.5;">（最有效）</small>
                </div>

                <div class="ka-row">
                    <input id="ka-use-audio" type="checkbox" />
                    <label>静音音频保活</label>
                    <small style="opacity:0.5;">（防冻结）</small>
                </div>

                <div class="ka-row">
                    <input id="ka-use-locks" type="checkbox" />
                    <label>Web Locks 锁</label>
                    <small style="opacity:0.5;">（防暂停）</small>
                </div>

                <div class="ka-row">
                    <input id="ka-use-wakelock" type="checkbox" />
                    <label>屏幕唤醒锁</label>
                    <small style="opacity:0.5;">（防灭屏，平板推荐）</small>
                </div>

                <div class="ka-row">
                    <input id="ka-show-heartbeat" type="checkbox" />
                    <label>显示心跳计数</label>
                </div>

                <div id="ka-status">
                    <span class="ka-dot"></span>
                    状态: <span id="ka-status-text">未启动</span>
                    <span style="float:right;opacity:0.5;">
                        心跳: #<span id="ka-heartbeat-count">0</span>
                    </span>
                </div>

            </div>
        </div>
    </div>`;

    $('#extensions_settings').append(html);
    loadSettings();

    // ===== 事件绑定 =====

    $('#ka-enabled').on('change', function () {
        const enabled = $(this).prop('checked');
        extension_settings[extensionName].enabled = enabled;
        saveSettingsDebounced();

        if (enabled) {
            startAll();
            toastr.success('后台保活已启用');
        } else {
            stopAll();
            toastr.info('后台保活已关闭');
        }
    });

    // 各子开关
    ['worker', 'audio', 'locks', 'wakelock'].forEach(key => {
        $(`#ka-use-${key}`).on('change', function () {
            const settingKey = 'use' + key.charAt(0).toUpperCase() + key.slice(1);
            if (key === 'wakelock') extension_settings[extensionName].useWakeLock = $(this).prop('checked');
            else if (key === 'locks') extension_settings[extensionName].useLocks = $(this).prop('checked');
            else if (key === 'audio') extension_settings[extensionName].useAudio = $(this).prop('checked');
            else if (key === 'worker') extension_settings[extensionName].useWorker = $(this).prop('checked');
            saveSettingsDebounced();

            // 重启保活
            if (getSettings().enabled) {
                stopAll();
                startAll();
            }
        });
    });

    $('#ka-show-heartbeat').on('change', function () {
        extension_settings[extensionName].showHeartbeat = $(this).prop('checked');
        saveSettingsDebounced();
    });

    // ===== 监听可见性变化 =====
    setupVisibilityListener();

    // ===== 自动启动 =====
    if (getSettings().enabled) {
        // 延迟 2 秒启动，等酒馆完全加载
        setTimeout(startAll, 2000);
    }

    console.log('[KeepAlive] ✅ 插件加载完成');
});
