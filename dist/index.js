const fs = require('fs');

const TERMINAL_STATUSES = new Set(['completed', 'failed']);
const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'];

function getInput(name, options = {}) {
    const envName = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
    const value = process.env[envName] || options.defaultValue || '';
    const trimmed = String(value).trim();

    if (options.required && !trimmed) {
        throw new Error(`Missing required input: ${name}`);
    }

    return trimmed;
}

function parseBoolean(value) {
    return ['1', 'true', 'yes', 'y'].includes(String(value || '').trim().toLowerCase());
}

function parsePositiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value || ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeApiUrl(value) {
    return String(value || '').trim().replace(/\/+$/, '');
}

function maskSecret(value) {
    if (value) {
        console.log(`::add-mask::${value}`);
    }
}

function escapeCommandValue(value) {
    return String(value || '')
        .replace(/%/g, '%25')
        .replace(/\r/g, '%0D')
        .replace(/\n/g, '%0A');
}

function setOutput(name, value) {
    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value || '')}\n`);
        return;
    }

    console.log(`::set-output name=${name}::${escapeCommandValue(value)}`);
}

function writeSummary(markdown) {
    if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
    }
}

async function requestJson(url, options) {
    const response = await fetch(url, options);
    const text = await response.text();
    let payload = {};

    if (text) {
        try {
            payload = JSON.parse(text);
        } catch {
            payload = { error: text };
        }
    }

    if (!response.ok) {
        const error = new Error(payload.error || `QuickChain request failed with ${response.status}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }

    return payload;
}

function getGitHubContext() {
    return {
        repository: process.env.GITHUB_REPOSITORY || null,
        repositoryId: process.env.GITHUB_REPOSITORY_ID || null,
        ref: process.env.GITHUB_REF || null,
        sha: process.env.GITHUB_SHA || null,
        workflow: process.env.GITHUB_WORKFLOW || null,
        runId: process.env.GITHUB_RUN_ID || null,
        runNumber: process.env.GITHUB_RUN_NUMBER || null,
        actor: process.env.GITHUB_ACTOR || null,
        eventName: process.env.GITHUB_EVENT_NAME || null,
        serverUrl: process.env.GITHUB_SERVER_URL || 'https://github.com',
    };
}

async function startScan({ apiUrl, apiKey, projectId }) {
    return requestJson(`${apiUrl}/api/ci/scans`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            projectId: projectId || undefined,
            ...getGitHubContext(),
        }),
    });
}

async function getScanStatus({ apiUrl, apiKey, scanId }) {
    return requestJson(`${apiUrl}/api/ci/scans/${encodeURIComponent(scanId)}`, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
    });
}

async function waitForScan({ apiUrl, apiKey, scanId, timeoutMinutes, pollIntervalSeconds }) {
    const startedAt = Date.now();
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const intervalMs = pollIntervalSeconds * 1000;
    let latest = null;

    while (Date.now() - startedAt < timeoutMs) {
        latest = await getScanStatus({ apiUrl, apiKey, scanId });
        const status = String(latest.status || '').toLowerCase();
        const telemetry = latest.telemetry ? ` - ${latest.telemetry}` : '';
        console.log(`QuickChain scan ${scanId}: ${status || 'processing'}${telemetry}`);

        if (TERMINAL_STATUSES.has(status)) {
            return latest;
        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`QuickChain scan ${scanId} did not finish within ${timeoutMinutes} minutes.`);
}

function shouldFailForFindings(findings, failOn) {
    const threshold = String(failOn || 'critical').toLowerCase();
    const counts = findings?.severityCounts || {};

    if (threshold === 'none') return false;
    if (threshold === 'any') return Number(findings?.total || 0) > 0;

    const thresholdIndex = SEVERITY_ORDER.indexOf(threshold);
    if (thresholdIndex === -1) {
        throw new Error(`Unsupported fail-on value: ${failOn}`);
    }

    return SEVERITY_ORDER
        .slice(thresholdIndex)
        .some((severity) => Number(counts[severity] || 0) > 0);
}

function writeOutputs(result) {
    const counts = result.findings?.severityCounts || {};
    setOutput('scan-id', result.scanId || '');
    setOutput('dashboard-url', result.dashboardUrl || '');
    setOutput('status', result.status || '');
    setOutput('critical-count', counts.critical || 0);
    setOutput('high-count', counts.high || 0);
    setOutput('medium-count', counts.medium || 0);
    setOutput('low-count', counts.low || 0);
    setOutput('total-count', result.findings?.total || 0);
}

function writeResultSummary(result) {
    const counts = result.findings?.severityCounts || {};
    const dashboardLine = result.dashboardUrl ? `\n\n[Open QuickChain dashboard](${result.dashboardUrl})` : '';

    writeSummary([
        '## QuickChain Scan',
        '',
        `Status: ${result.status || 'accepted'}`,
        `Scan ID: ${result.scanId || 'unavailable'}`,
        '',
        '| Severity | Count |',
        '| --- | ---: |',
        `| Critical | ${counts.critical || 0} |`,
        `| High | ${counts.high || 0} |`,
        `| Medium | ${counts.medium || 0} |`,
        `| Low | ${counts.low || 0} |`,
        `| Total | ${result.findings?.total || 0} |`,
        dashboardLine,
    ].join('\n'));
}

async function main() {
    const apiKey = getInput('api-key', { required: true });
    const apiUrl = normalizeApiUrl(getInput('api-url', { defaultValue: 'https://ironridgecyber.com' }));
    const projectId = getInput('project-id');
    const failOn = getInput('fail-on', { defaultValue: 'critical' });
    const wait = parseBoolean(getInput('wait', { defaultValue: 'true' }));
    const timeoutMinutes = parsePositiveInteger(getInput('timeout-minutes', { defaultValue: '35' }), 35);
    const pollIntervalSeconds = parsePositiveInteger(getInput('poll-interval-seconds', { defaultValue: '15' }), 15);

    maskSecret(apiKey);

    const accepted = await startScan({ apiUrl, apiKey, projectId });
    console.log(`QuickChain scan accepted: ${accepted.scanId}`);

    let result = {
        ...accepted,
        scanId: accepted.scanId,
        status: accepted.status || 'accepted',
        findings: {
            total: 0,
            severityCounts: {},
        },
    };

    if (wait) {
        result = await waitForScan({
            apiUrl,
            apiKey,
            scanId: accepted.scanId,
            timeoutMinutes,
            pollIntervalSeconds,
        });
    }

    writeOutputs(result);
    writeResultSummary(result);

    if (String(result.status || '').toLowerCase() === 'failed') {
        throw new Error(`QuickChain scan ${result.scanId} failed.`);
    }

    if (wait && shouldFailForFindings(result.findings, failOn)) {
        const counts = result.findings?.severityCounts || {};
        throw new Error(
            `QuickChain found vulnerabilities at or above '${failOn}' severity ` +
            `(critical: ${counts.critical || 0}, high: ${counts.high || 0}, medium: ${counts.medium || 0}, low: ${counts.low || 0}).`
        );
    }
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`::error title=QuickChain::${escapeCommandValue(message)}`);
    process.exitCode = 1;
});
