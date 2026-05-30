const fs = require('fs');
const path = require('path');

const TERMINAL_STATUSES = new Set(['completed', 'failed']);
const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'];
const SUMMARY_SEVERITIES = ['critical', 'high', 'medium', 'low'];

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

function formatAvailability(value) {
    return value ? 'Yes' : 'No';
}

function formatSummaryText(value, maxLength = 1800) {
    const text = String(value || '').trim();
    if (!text) return '';
    return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
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

async function requestBuffer(url, options) {
    const response = await fetch(url, options);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (!response.ok) {
        let message = `QuickChain request failed with ${response.status}`;
        const text = buffer.toString('utf8');
        if (text) {
            try {
                message = JSON.parse(text).error || message;
            } catch {
                message = text;
            }
        }
        const error = new Error(message);
        error.status = response.status;
        throw error;
    }

    return buffer;
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

async function downloadScanArtifact({ apiUrl, apiKey, scanId, artifactPath }) {
    return requestBuffer(`${apiUrl}/api/ci/scans/${encodeURIComponent(scanId)}/${artifactPath}`, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${apiKey}`,
        },
    });
}

function prepareOutputDirectory(outputDirectory) {
    const workspace = process.cwd();
    const resolved = path.resolve(workspace, outputDirectory || 'QuickChainResults');
    const relative = path.relative(workspace, resolved);

    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('output-directory must be a child directory inside the checked-out repository.');
    }

    fs.rmSync(resolved, { recursive: true, force: true });
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
}

async function writeScanArtifacts({ apiUrl, apiKey, scanId, outputDirectory }) {
    const resolvedOutputDirectory = prepareOutputDirectory(outputDirectory);

    const artifacts = [
        { artifactPath: 'sbom', filename: 'sbom.json' },
        { artifactPath: 'vex', filename: 'openvex.json' },
        { artifactPath: 'remediation.pdf', filename: 'remediation.pdf' },
    ];

    for (const artifact of artifacts) {
        const buffer = await downloadScanArtifact({
            apiUrl,
            apiKey,
            scanId,
            artifactPath: artifact.artifactPath,
        });
        const filePath = path.join(resolvedOutputDirectory, artifact.filename);
        fs.writeFileSync(filePath, buffer);
        console.log(`QuickChain wrote ${path.relative(process.cwd(), filePath)}`);
    }
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
    const reachableCounts = result.findings?.reachableSeverityCounts || {};
    setOutput('scan-id', result.scanId || '');
    setOutput('dashboard-url', result.dashboardUrl || '');
    setOutput('status', result.status || '');
    setOutput('critical-count', counts.critical || 0);
    setOutput('high-count', counts.high || 0);
    setOutput('medium-count', counts.medium || 0);
    setOutput('low-count', counts.low || 0);
    setOutput('total-count', result.findings?.total || 0);
    setOutput('critical-reachable-count', reachableCounts.critical || 0);
    setOutput('high-reachable-count', reachableCounts.high || 0);
    setOutput('medium-reachable-count', reachableCounts.medium || 0);
    setOutput('low-reachable-count', reachableCounts.low || 0);
    setOutput('reachable-count', result.findings?.reachable || 0);
    setOutput('sbom-available', result.artifacts?.sbomAvailable ? 'true' : 'false');
    setOutput('vex-available', result.artifacts?.vexAvailable ? 'true' : 'false');
    setOutput('results-directory', result.resultsDirectory || '');
}

function writeResultSummary(result) {
    const counts = result.findings?.severityCounts || {};
    const reachableCounts = result.findings?.reachableSeverityCounts || {};
    const dashboardLine = result.dashboardUrl ? `\n\n[Open QuickChain dashboard](${result.dashboardUrl})` : '';
    const remediationSummary = formatSummaryText(result.aiSummary);
    const resultsLine = result.resultsDirectory ? `\n\nResults directory: \`${result.resultsDirectory}\`` : '';
    const severityRows = SUMMARY_SEVERITIES.map((severity) => {
        const label = severity.charAt(0).toUpperCase() + severity.slice(1);
        return `| ${label} | ${counts[severity] || 0} | ${reachableCounts[severity] || 0} |`;
    });

    writeSummary([
        '## QuickChain Scan',
        '',
        `Status: ${result.status || 'accepted'}`,
        `Scan ID: ${result.scanId || 'unavailable'}`,
        '',
        '| Severity | Count | Potentially Reachable |',
        '| --- | ---: | ---: |',
        ...severityRows,
        `| Total | ${result.findings?.total || 0} | ${result.findings?.reachable || 0} |`,
        '',
        `SBOM available: ${formatAvailability(result.artifacts?.sbomAvailable)}`,
        `VEX available: ${formatAvailability(result.artifacts?.vexAvailable)}`,
        ...(remediationSummary ? ['', '### Remediation Summary', '', remediationSummary] : []),
        resultsLine,
        dashboardLine,
    ].join('\n'));
}

function shouldFailForFindingsWithReachability(findings, failOn, reachableOnly) {
    if (!reachableOnly) {
        return shouldFailForFindings(findings, failOn);
    }

    return shouldFailForFindings({
        ...findings,
        total: findings?.reachable || 0,
        severityCounts: findings?.reachableSeverityCounts || {},
    }, failOn);
}

async function main() {
    const apiKey = getInput('api-key', { required: true });
    const apiUrl = normalizeApiUrl(getInput('api-url', { defaultValue: 'https://ironridgecyber.com' }));
    const projectId = getInput('project-id');
    const failOn = getInput('fail-on', { defaultValue: 'critical' });
    const failOnReachableOnly = parseBoolean(getInput('fail-on-reachable-only', { defaultValue: 'false' }));
    const wait = parseBoolean(getInput('wait', { defaultValue: 'true' }));
    const writeArtifacts = parseBoolean(getInput('write-artifacts', { defaultValue: 'true' }));
    const outputDirectory = getInput('output-directory', { defaultValue: 'QuickChainResults' }) || 'QuickChainResults';
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
            reachable: 0,
            severityCounts: {},
            reachableSeverityCounts: {},
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

    if (wait && writeArtifacts && String(result.status || '').toLowerCase() === 'completed') {
        await writeScanArtifacts({
            apiUrl,
            apiKey,
            scanId: accepted.scanId,
            outputDirectory,
        });
        result.resultsDirectory = outputDirectory;
    } else if (writeArtifacts && !wait) {
        console.log('QuickChain artifact download skipped because wait is false.');
    }

    writeOutputs(result);
    writeResultSummary(result);

    if (String(result.status || '').toLowerCase() === 'failed') {
        throw new Error(`QuickChain scan ${result.scanId} failed.`);
    }

    if (wait && shouldFailForFindingsWithReachability(result.findings, failOn, failOnReachableOnly)) {
        const counts = failOnReachableOnly
            ? result.findings?.reachableSeverityCounts || {}
            : result.findings?.severityCounts || {};
        const scope = failOnReachableOnly ? 'potentially reachable vulnerabilities' : 'vulnerabilities';
        throw new Error(
            `QuickChain found ${scope} at or above '${failOn}' severity ` +
            `(critical: ${counts.critical || 0}, high: ${counts.high || 0}, medium: ${counts.medium || 0}, low: ${counts.low || 0}).`
        );
    }
}

main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`::error title=QuickChain::${escapeCommandValue(message)}`);
    process.exitCode = 1;
});
