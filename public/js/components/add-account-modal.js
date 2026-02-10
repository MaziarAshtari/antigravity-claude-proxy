/**
 * Add Account Modal Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.addAccountModal = () => ({
    manualMode: false,
    authUrl: '',
    authState: '',
    callbackInput: '',
    submitting: false,
    _oauthListener: null,

    init() {
        // Allow other parts of the UI (and remote/VPS mode) to inject an OAuth URL + state
        // so the user can complete the flow via Manual Mode.
        this._oauthListener = (e) => {
            const detail = e?.detail || {};
            if (detail.url) this.authUrl = detail.url;
            if (detail.state) this.authState = detail.state;
            if (typeof detail.mode === 'string' && detail.mode.toLowerCase() === 'manual') {
                // Ensure the modal and Manual Mode section are visible.
                const dlg = document.getElementById('add_account_modal');
                if (dlg && !dlg.open && dlg.showModal) {
                    dlg.showModal();
                }
                Alpine.nextTick(() => {
                    const manualDetails = document.querySelector('#add_account_modal details');
                    if (manualDetails) manualDetails.open = true;
                    const input = document.querySelector('#add_account_modal input[x-model=\"callbackInput\"]');
                    if (input) input.focus();
                });
            }
        };
        window.addEventListener('ag-oauth-started', this._oauthListener);
    },

    /**
     * Reset all state to initial values
     */
    resetState() {
        this.manualMode = false;
        this.authUrl = '';
        this.authState = '';
        this.callbackInput = '';
        this.submitting = false;
        // Close any open details elements
        const details = document.querySelectorAll('#add_account_modal details[open]');
        details.forEach(d => d.removeAttribute('open'));
    },

    async copyLink() {
        if (!this.authUrl) return;
        await navigator.clipboard.writeText(this.authUrl);
        Alpine.store('global').showToast(Alpine.store('global').t('linkCopied'), 'success');
    },

    async initManualAuth(event) {
        if (event.target.open && !this.authUrl) {
            try {
                const password = Alpine.store('global').webuiPassword;
                const {
                    response,
                    newPassword
                } = await window.utils.request('/api/auth/url?mode=manual', {}, password);
                if (newPassword) Alpine.store('global').webuiPassword = newPassword;
                const data = await response.json();
                if (data.status === 'ok') {
                    this.authUrl = data.url;
                    this.authState = data.state;
                }
            } catch (e) {
                Alpine.store('global').showToast(e.message, 'error');
            }
        }
    },

    async completeManualAuth() {
        if (!this.callbackInput || !this.authState) return;
        this.submitting = true;
        try {
            const store = Alpine.store('global');
            const {
                response,
                newPassword
            } = await window.utils.request('/api/auth/complete', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    callbackInput: this.callbackInput,
                    state: this.authState
                })
            }, store.webuiPassword);
            if (newPassword) store.webuiPassword = newPassword;
            const data = await response.json();
            if (data.status === 'ok') {
                store.showToast(store.t('accountAddedSuccess'), 'success');
                Alpine.store('data').fetchData();
                document.getElementById('add_account_modal').close();
                this.resetState();
            } else {
                store.showToast(data.error || store.t('authFailed'), 'error');
            }
        } catch (e) {
            Alpine.store('global').showToast(e.message, 'error');
        } finally {
            this.submitting = false;
        }
    }
});
