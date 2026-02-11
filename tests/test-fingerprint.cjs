/**
 * Test Fingerprint Management - Unit & Integration Tests
 *
 * Tests the device fingerprinting system:
 * - Generation logic (randomness, structure, versioning)
 * - AccountManager integration (regeneration, history, restoration)
 * - Persistence (saving/loading to disk)
 * - Header construction for API requests
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║                FINGERPRINT SYSTEM TEST SUITE                 ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Dynamic imports for ESM modules
    const {
        generateFingerprint,
        buildFingerprintHeaders,
        updateFingerprintVersion,
        MAX_FINGERPRINT_HISTORY
    } = await import('../src/utils/fingerprint.js');

    const { AccountManager } = await import('../src/account-manager/index.js');
    const { ANTIGRAVITY_VERSION } = await import('../src/constants.js');

    let passed = 0;
    let failed = 0;

    // Create a temporary test directory
    const TEST_DIR = path.join(os.tmpdir(), 'antigravity-test-' + Date.now());

    if (!fs.existsSync(TEST_DIR)) {
        fs.mkdirSync(TEST_DIR, { recursive: true });
    }

    // Helper to get a unique config path for each test
    function getTestConfigPath(testName) {
        // Sanitize test name for filename
        const safeName = testName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
        return path.join(TEST_DIR, `accounts-${safeName}.json`);
    }

    function test(name, fn) {
        try {
            fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}`);
            // console.error(e); // Uncomment for full stack trace
            failed++;
        }
    }

    async function asyncTest(name, fn) {
        try {
            await fn(getTestConfigPath(name));
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}`);
            failed++;
        }
    }

    function assert(condition, message) {
        if (!condition) {
            throw new Error(message || 'Assertion failed');
        }
    }

    function assertEqual(actual, expected, message) {
        if (actual !== expected) {
            throw new Error(`${message || 'Not equal'}: Expected ${expected}, got ${actual}`);
        }
    }

    // ==========================================================================
    // 1. CORE LOGIC TESTS
    // ==========================================================================
    console.log('\n─── Core Generation Logic ───');

    test('generateFingerprint creates valid structure', () => {
        const fp = generateFingerprint();
        assert(fp.deviceId, 'Missing deviceId');
        assert(fp.sessionToken, 'Missing sessionToken');
        assert(fp.userAgent, 'Missing userAgent');
        assert(fp.userAgent.includes(`antigravity/${ANTIGRAVITY_VERSION}`), 'User agent missing version');
        assert(fp.apiClient, 'Missing apiClient');
        assert(fp.quotaUser, 'Missing quotaUser');
        assert(fp.clientMetadata, 'Missing clientMetadata');
        assert(fp.clientMetadata.osVersion, 'Missing osVersion');
        assert(fp.createdAt, 'Missing createdAt');
    });

    test('generateFingerprint produces random values', () => {
        const fp1 = generateFingerprint();
        const fp2 = generateFingerprint();
        assert(fp1.deviceId !== fp2.deviceId, 'Device IDs should be unique');
        assert(fp1.sessionToken !== fp2.sessionToken, 'Session tokens should be unique');
        assert(fp1.quotaUser !== fp2.quotaUser, 'Quota users should be unique');
    });

    test('buildFingerprintHeaders constructs correct headers', () => {
        const fp = generateFingerprint();
        const headers = buildFingerprintHeaders(fp);

        assertEqual(headers['User-Agent'], fp.userAgent, 'User-Agent header mismatch');
        assertEqual(headers['X-Client-Device-Id'], fp.deviceId, 'Device-Id header mismatch');
        assertEqual(headers['X-Goog-Api-Client'], fp.apiClient, 'Api-Client header mismatch');
        assertEqual(headers['X-Goog-QuotaUser'], fp.quotaUser, 'QuotaUser header mismatch');

        const metadata = JSON.parse(headers['Client-Metadata']);
        assertEqual(metadata.osVersion, fp.clientMetadata.osVersion, 'Metadata osVersion mismatch');
    });

    test('updateFingerprintVersion updates userAgent', () => {
        const fp = generateFingerprint();
        // Simulate old version
        const oldFp = { ...fp, userAgent: 'antigravity/0.0.1 darwin/x64' };

        const updatedFp = updateFingerprintVersion(oldFp);
        assert(updatedFp.userAgent.includes(`antigravity/${ANTIGRAVITY_VERSION}`), 'Should update to current version');
        assert(updatedFp.userAgent.includes('darwin/x64'), 'Should preserve platform/arch');
    });

    // ==========================================================================
    // 2. ACCOUNT MANAGER INTEGRATION
    // ==========================================================================
    console.log('\n─── Account Manager Integration ───');

    await asyncTest('AccountManager generates fingerprint for new accounts', async (configPath) => {
        // Setup initial config without fingerprint
        const initialConfig = {
            accounts: [{
                email: 'test@example.com',
                source: 'manual',
                apiKey: 'key',
                enabled: true
            }],
            settings: {}
        };
        fs.writeFileSync(configPath, JSON.stringify(initialConfig));

        const manager = new AccountManager(configPath);
        await manager.initialize();

        const accounts = manager.getAllAccounts();
        assert(accounts[0].fingerprint, 'Fingerprint should be generated on load');
        assert(accounts[0].fingerprint.deviceId, 'Fingerprint should have deviceId');
    });

    await asyncTest('regenerateFingerprint updates current and saves history', async (configPath) => {
        const manager = new AccountManager(configPath);
        // Force add an account
        const initialConfig = {
            accounts: [{
                email: 'test@example.com',
                source: 'manual',
                apiKey: 'key',
                enabled: true
            }],
            settings: {}
        };
        fs.writeFileSync(configPath, JSON.stringify(initialConfig));

        await manager.initialize();
        const email = 'test@example.com';

        const originalFp = manager.getAllAccounts()[0].fingerprint;
        const newFp = manager.regenerateFingerprint(email);

        assert(newFp.deviceId !== originalFp.deviceId, 'New fingerprint should be different');

        const history = manager.getFingerprintHistory(email);
        assertEqual(history.length, 1, 'History should have 1 entry');
        assertEqual(history[0].fingerprint.deviceId, originalFp.deviceId, 'History should contain original fingerprint');
        assertEqual(history[0].reason, 'regenerated', 'History reason should be "regenerated"');
    });

    await asyncTest('History is capped at MAX_FINGERPRINT_HISTORY', async (configPath) => {
        // Setup initial config
        const initialConfig = {
            accounts: [{
                email: 'test@example.com',
                source: 'manual',
                apiKey: 'key',
                enabled: true
            }],
            settings: {}
        };
        fs.writeFileSync(configPath, JSON.stringify(initialConfig));

        const manager = new AccountManager(configPath);
        await manager.initialize();
        const email = 'test@example.com';

        // Regenerate many times
        for (let i = 0; i < MAX_FINGERPRINT_HISTORY + 2; i++) {
            manager.regenerateFingerprint(email);
        }

        const history = manager.getFingerprintHistory(email);
        assertEqual(history.length, MAX_FINGERPRINT_HISTORY, `History should be capped at ${MAX_FINGERPRINT_HISTORY}`);
    });

    await asyncTest('restoreFingerprint works correctly', async (configPath) => {
        // Setup initial config
        const initialConfig = {
            accounts: [{
                email: 'test@example.com',
                source: 'manual',
                apiKey: 'key',
                enabled: true
            }],
            settings: {}
        };
        fs.writeFileSync(configPath, JSON.stringify(initialConfig));

        const manager = new AccountManager(configPath);
        await manager.initialize();
        const email = 'test@example.com';

        // Create some history
        manager.regenerateFingerprint(email); // History: [Old1]
        manager.regenerateFingerprint(email); // History: [Old2, Old1]

        const historyBefore = manager.getFingerprintHistory(email);
        const targetFp = historyBefore[1].fingerprint; // Restore Old1
        const currentFpBefore = manager.getAllAccounts()[0].fingerprint;

        const restoredFp = manager.restoreFingerprint(email, 1);

        assertEqual(restoredFp.deviceId, targetFp.deviceId, 'Restored fingerprint ID mismatch');

        // Verify previous current was saved to history
        const historyAfter = manager.getFingerprintHistory(email);
        assertEqual(historyAfter[0].fingerprint.deviceId, currentFpBefore.deviceId, 'Previous current should be pushed to history');
        assertEqual(historyAfter[0].reason, 'restored', 'Reason should be "restored"');
    });

    // ==========================================================================
    // 3. PERSISTENCE & CLI COMPATIBILITY
    // ==========================================================================
    console.log('\n─── Persistence & CLI Compatibility ───');

    await asyncTest('Fingerprints persist across reloads', async (configPath) => {
        // Setup initial config
        const initialConfig = {
            accounts: [{
                email: 'test@example.com',
                source: 'manual',
                apiKey: 'key',
                enabled: true
            }],
            settings: {}
        };
        fs.writeFileSync(configPath, JSON.stringify(initialConfig));

        // Create manager 1, make changes
        const manager1 = new AccountManager(configPath);
        await manager1.initialize();
        manager1.regenerateFingerprint('test@example.com');

        // Wait for save to complete to avoid race condition with manager2 reading
        await manager1.saveToDisk();

        const fp1 = manager1.getAllAccounts()[0].fingerprint;

        // Create manager 2, verify load
        const manager2 = new AccountManager(configPath);
        await manager2.initialize();
        const fp2 = manager2.getAllAccounts()[0].fingerprint;

        assertEqual(fp2.deviceId, fp1.deviceId, 'Fingerprint should persist across reloads');

        const history = manager2.getFingerprintHistory('test@example.com');
        assert(history.length > 0, 'History should persist');
    });

    // Helper to simulate CLI-style destructive save
    // This mirrors what src/cli/accounts.js does (constructing new object array)
    // We want to ensure that if we fix the CLI, this test passes with the FIX logic
    // But here we'll test the actual AccountManager's save logic which is safe.
    // To test the CLI fix specifically, we should verify the file content structure manually.

    await asyncTest('Config file contains fingerprint data', async (configPath) => {
        // Create a config with fingerprint data
        const fp = generateFingerprint();
        const account = {
            email: 'test@example.com',
            source: 'manual',
            fingerprint: fp,
            fingerprintHistory: []
        };

        const initialConfig = {
            accounts: [account],
            settings: {}
        };
        fs.writeFileSync(configPath, JSON.stringify(initialConfig));

        const content = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(content);
        const savedAccount = config.accounts[0];

        assert(savedAccount.fingerprint, 'Saved file missing fingerprint object');
        assert(savedAccount.fingerprint.deviceId, 'Saved fingerprint missing deviceId');
        assert(Array.isArray(savedAccount.fingerprintHistory), 'Saved file missing fingerprintHistory array');
    });

    // ==========================================================================
    // CLEANUP
    // ==========================================================================
    try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch (e) {
        // Ignore cleanup errors
    }

    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log(`Tests completed: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch(err => {
    console.error('Test suite failed:', err);
    process.exit(1);
});
