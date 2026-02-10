/**
 * Antigravity Console - Main Entry
 *
 * This file orchestrates Alpine.js initialization.
 * Components are loaded via separate script files that register themselves
 * to window.Components before this script runs.
 */

document.addEventListener('alpine:init', () => {
    // Register Components (loaded from separate files via window.Components)
    Alpine.data('dashboard', window.Components.dashboard);
    Alpine.data('models', window.Components.models);
    Alpine.data('accountManager', window.Components.accountManager);
    Alpine.data('claudeConfig', window.Components.claudeConfig);
    Alpine.data('logsViewer', window.Components.logsViewer);
    Alpine.data('addAccountModal', window.Components.addAccountModal);

    // View Loader Directive
    Alpine.directive('load-view', (el, { expression }, { evaluate }) => {
        if (!window.viewCache) window.viewCache = new Map();

        // Evaluate the expression to get the actual view name (removes quotes)
        const viewName = evaluate(expression);

        if (window.viewCache.has(viewName)) {
            el.innerHTML = window.viewCache.get(viewName);
            Alpine.initTree(el);
            return;
        }

        fetch(`views/${viewName}.html?t=${Date.now()}`)
            .then(response => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                return response.text();
            })
            .then(html => {
                // Update cache (optional, or remove if we want always-fresh)
                // keeping cache for session performance, but initial load will now bypass browser cache
                window.viewCache.set(viewName, html);
                el.innerHTML = html;
                Alpine.initTree(el);
            })
            .catch(err => {
                console.error('Failed to load view:', viewName, err);
                el.innerHTML = `<div class="p-4 border border-red-500/50 bg-red-500/10 rounded-lg text-red-400 font-mono text-sm">
                    Error loading view: ${viewName}<br>
                    <span class="text-xs opacity-75">${err.message}</span>
                </div>`;
            });
    });

    // Main App Controller
    Alpine.data('app', () => ({
        get connectionStatus() {
            return Alpine.store('data')?.connectionStatus || 'connecting';
        },
        get loading() {
            return Alpine.store('data')?.loading || false;
        },

        sidebarOpen: window.innerWidth >= 1024,
        toggleSidebar() {
            this.sidebarOpen = !this.sidebarOpen;
        },

        init() {
            // Handle responsive sidebar transitions
            let lastWidth = window.innerWidth;
            let resizeTimeout = null;
            
            window.addEventListener('resize', () => {
                if (resizeTimeout) clearTimeout(resizeTimeout);
                
                resizeTimeout = setTimeout(() => {
                    const currentWidth = window.innerWidth;
                    const lgBreakpoint = 1024;
                    
                    // Desktop -> Mobile: Auto-close sidebar to prevent overlay blocking screen
                    if (lastWidth >= lgBreakpoint && currentWidth < lgBreakpoint) {
                        this.sidebarOpen = false;
                    }
                    
                    // Mobile -> Desktop: Auto-open sidebar (restore standard desktop layout)
                    if (lastWidth < lgBreakpoint && currentWidth >= lgBreakpoint) {
                        this.sidebarOpen = true;
                    }
                    
                    lastWidth = currentWidth;
                }, 150);
            });

            // Theme setup
            document.documentElement.setAttribute('data-theme', 'black');
            document.documentElement.classList.add('dark');

            // Chart Defaults
            if (typeof Chart !== 'undefined') {
                Chart.defaults.color = window.utils.getThemeColor('--color-text-dim');
                Chart.defaults.borderColor = window.utils.getThemeColor('--color-space-border');
                Chart.defaults.font.family = '"JetBrains Mono", monospace';
            }

            // Start Data Polling
            this.startAutoRefresh();
            document.addEventListener('refresh-interval-changed', () => this.startAutoRefresh());

            // Initial Fetch
            Alpine.store('data').fetchData();
        },

        refreshTimer: null,

        fetchData() {
            Alpine.store('data').fetchData();
        },

        startAutoRefresh() {
            if (this.refreshTimer) clearInterval(this.refreshTimer);
            const interval = parseInt(Alpine.store('settings')?.refreshInterval || 60);
            if (interval > 0) {
                this.refreshTimer = setInterval(() => Alpine.store('data').fetchData(), interval * 1000);
            }
        },

        t(key) {
            return Alpine.store('global')?.t(key) || key;
        },

        async addAccountWeb(reAuthEmail = null) {
            const password = Alpine.store('global').webuiPassword;
            try {
                const isLoopback = window.utils?.isLoopbackHost
                    ? window.utils.isLoopbackHost(window.location.hostname)
                    : ['localhost', '127.0.0.1', '::1', '[::1]'].includes(window.location.hostname);

                // Auto mode only works when the browser and server are on the same machine
                // (because Google redirects to http://localhost:PORT/...).
                const mode = isLoopback ? 'auto' : 'manual';

                const params = new URLSearchParams();
                if (reAuthEmail) params.set('email', reAuthEmail);
                params.set('mode', mode);
                const urlPath = `/api/auth/url?${params.toString()}`;

                const { response, newPassword } = await window.utils.request(urlPath, {}, password);
                if (newPassword) Alpine.store('global').webuiPassword = newPassword;

                const data = await response.json();

                if (data.status === 'ok') {
                    // Show info toast that OAuth is in progress
                    Alpine.store('global').showToast(Alpine.store('global').t('oauthInProgress'), 'info');

                    // Publish auth URL + state so Manual Mode can be used as a fallback (or primary on VPS).
                    try {
                        window.dispatchEvent(new CustomEvent('ag-oauth-started', {
                            detail: { url: data.url, state: data.state, mode }
                        }));
                    } catch {
                        // Ignore CustomEvent failures (older browsers) - Manual Mode can still fetch its own URL.
                    }

                    // Open OAuth window
                    const oauthWindow = window.open(data.url, 'google_oauth', 'width=600,height=700,scrollbars=yes');

                    // Manual/VPS mode: user must paste the callback URL/code (localhost redirect can't hit the VPS).
                    if (mode === 'manual') {
                        Alpine.store('global').showToast(
                            `${Alpine.store('global').t('manualMode')}: ${Alpine.store('global').t('pasteCallbackLabel')}`,
                            'info'
                        );
                        return;
                    }

                    // Poll for account changes instead of relying on postMessage
                    // (since OAuth callback is now on port 51121, not this server)
                    const initialAccountCount = Alpine.store('data').accounts.length;
                    let pollCount = 0;
                    const maxPolls = 60; // 2 minutes (2 second intervals)
                    let cancelled = false;
                    const authState = data.state;
                    const authUrl = data.url;

                    // Show progress modal
                    Alpine.store('global').oauthProgress = {
                        active: true,
                        current: 0,
                        max: maxPolls,
                        cancel: () => {
                            cancelled = true;
                            clearInterval(pollInterval);
                            Alpine.store('global').oauthProgress.active = false;
                            Alpine.store('global').showToast(Alpine.store('global').t('oauthCancelled'), 'info');
                            if (oauthWindow && !oauthWindow.closed) {
                                oauthWindow.close();
                            }
                            // Best-effort: stop the callback server early.
                            window.utils.request('/api/auth/cancel', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ state: authState })
                            }, Alpine.store('global').webuiPassword).catch(() => {});
                        }
                    };

                    const pollInterval = setInterval(async () => {
                        if (cancelled) {
                            clearInterval(pollInterval);
                            return;
                        }

                        pollCount++;
                        Alpine.store('global').oauthProgress.current = pollCount;

                        // Check if OAuth window was closed manually
                        if (oauthWindow && oauthWindow.closed && !cancelled) {
                            clearInterval(pollInterval);
                            Alpine.store('global').oauthProgress.active = false;
                            Alpine.store('global').showToast(Alpine.store('global').t('oauthWindowClosed'), 'warning');
                            // Offer Manual Mode fallback with the same state/verifier.
                            try {
                                window.dispatchEvent(new CustomEvent('ag-oauth-started', {
                                    detail: { url: authUrl, state: authState, mode: 'manual' }
                                }));
                            } catch {}
                            return;
                        }

                        // Refresh account list
                        await Alpine.store('data').fetchData();

                        // Check if new account was added
                        const currentAccountCount = Alpine.store('data').accounts.length;
                        if (currentAccountCount > initialAccountCount) {
                            clearInterval(pollInterval);
                            Alpine.store('global').oauthProgress.active = false;

                            const actionKey = reAuthEmail ? 'accountReauthSuccess' : 'accountAddedSuccess';
                            Alpine.store('global').showToast(
                                Alpine.store('global').t(actionKey),
                                'success'
                            );
                            document.getElementById('add_account_modal')?.close();

                            if (oauthWindow && !oauthWindow.closed) {
                                oauthWindow.close();
                            }
                        }

                        // Stop polling after max attempts
                        if (pollCount >= maxPolls) {
                            clearInterval(pollInterval);
                            Alpine.store('global').oauthProgress.active = false;
                            Alpine.store('global').showToast(
                                Alpine.store('global').t('oauthTimeout'),
                                'warning'
                            );
                            // Offer Manual Mode fallback with the same state/verifier.
                            try {
                                window.dispatchEvent(new CustomEvent('ag-oauth-started', {
                                    detail: { url: authUrl, state: authState, mode: 'manual' }
                                }));
                            } catch {}
                        }
                    }, 2000); // Poll every 2 seconds
                } else {
                    Alpine.store('global').showToast(data.error || Alpine.store('global').t('failedToGetAuthUrl'), 'error');
                }
            } catch (e) {
                Alpine.store('global').showToast(Alpine.store('global').t('failedToStartOAuth') + ': ' + e.message, 'error');
            }
        }
    }));
});
