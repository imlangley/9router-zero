"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import PropTypes from "prop-types";
import { Modal, Button, Input } from "@/shared/components";

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PROXY_MODE = "active-round-robin";
const PLAYWRIGHT_PROXY_POOL_TYPES = new Set(["http", "https", "socks", "socks4", "socks5"]);
const BULK_JOB_STORAGE_KEY = "kiro-bulk-import-active-job";
const JOB_SESSION_EXPIRED_MESSAGE = "Bulk import progress could not be restored. The previous job session was cleared.";

function isJobTerminal(status) {
  return ["completed", "cancelled", "failed"].includes(status);
}

function isJobActive(status) {
  return ["queued", "running", "needs_manual"].includes(status);
}

function formatStepLabel(step) {
  if (!step) return "waiting";
  return step.replaceAll("_", " ");
}

function formatClock(value) {
  if (!value) return "--:--:--";

  try {
    return new Date(value).toLocaleTimeString("id-ID", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return value;
  }
}

function groupAccountsByStatus(accounts = []) {
  const order = ["running", "queued", "needs_manual", "success", "skipped_duplicate", "skipped_duplicate_input", "failed", "failed_invalid_credentials", "failed_exchange", "failed_timeout", "cancelled"];
  const grouped = new Map();

  accounts.forEach((account) => {
    const key = account.status || "queued";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(account);
  });

  return order
    .filter((status) => grouped.has(status))
    .map((status) => ({ status, accounts: grouped.get(status) }));
}

function getStatusPanelClasses(status) {
  const styles = {
    queued: "border-slate-200 bg-slate-50/80 dark:border-slate-800 dark:bg-slate-900/20",
    running: "border-blue-200 bg-blue-50/80 dark:border-blue-900/50 dark:bg-blue-950/20",
    success: "border-green-200 bg-green-50/80 dark:border-green-900/50 dark:bg-green-950/20",
    skipped_duplicate: "border-slate-200 bg-slate-50/80 dark:border-slate-800 dark:bg-slate-900/20",
    skipped_duplicate_input: "border-slate-200 bg-slate-50/80 dark:border-slate-800 dark:bg-slate-900/20",
    failed: "border-red-200 bg-red-50/80 dark:border-red-900/50 dark:bg-red-950/20",
    failed_invalid_credentials: "border-red-200 bg-red-50/80 dark:border-red-900/50 dark:bg-red-950/20",
    failed_exchange: "border-red-200 bg-red-50/80 dark:border-red-900/50 dark:bg-red-950/20",
    failed_timeout: "border-red-200 bg-red-50/80 dark:border-red-900/50 dark:bg-red-950/20",
    needs_manual: "border-amber-200 bg-amber-50/80 dark:border-amber-900/50 dark:bg-amber-950/20",
    cancelled: "border-slate-200 bg-slate-50/80 dark:border-slate-800 dark:bg-slate-900/20",
  };

  return styles[status] || styles.queued;
}

async function fetchBulkJobById(jobId) {
  if (!jobId) return null;
  const res = await fetch(`/api/oauth/kiro/bulk-import/${jobId}`, { cache: "no-store" });
  const data = await res.json();
  return { res, data };
}

async function fetchLatestBulkJob(scope = "active") {
  const res = await fetch(`/api/oauth/kiro/bulk-import/latest?scope=${encodeURIComponent(scope)}`, { cache: "no-store" });
  const data = await res.json();
  return { res, data };
}

function AccountStatusBadge({ status }) {
  const palette = {
    queued: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
    running: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
    success: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    skipped_duplicate: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
    skipped_duplicate_input: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
    failed: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    failed_invalid_credentials: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    failed_exchange: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    failed_timeout: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    needs_manual: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    cancelled: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  };

  return (
    <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${palette[status] || palette.queued}`}>
      {status.replaceAll("_", " ")}
    </span>
  );
}

AccountStatusBadge.propTypes = {
  status: PropTypes.string.isRequired,
};

export default function KiroAuthModal({
  isOpen,
  onMethodSelect,
  onImportSuccess,
  onClose,
  initialJobId,
  initialSelectedMethod,
  initialImportMode,
  initialFlowKey,
  onBulkJobChange,
}) {
  const [selectedMethod, setSelectedMethod] = useState(null);
  const [idcStartUrl, setIdcStartUrl] = useState("");
  const [idcRegion, setIdcRegion] = useState("us-east-1");
  const [refreshToken, setRefreshToken] = useState("");
  const [importMode, setImportMode] = useState("single-token");
  const [bulkText, setBulkText] = useState("");
  const [concurrency, setConcurrency] = useState(String(DEFAULT_CONCURRENCY));
  const [proxyMode, setProxyMode] = useState(DEFAULT_PROXY_MODE);
  const [selectedProxyPoolId, setSelectedProxyPoolId] = useState("");
  const [proxyPools, setProxyPools] = useState([]);
  const [bulkResult, setBulkResult] = useState(null);
  const [activeJob, setActiveJob] = useState(null);
  const [error, setError] = useState(null);
  const [jobRestoreNotice, setJobRestoreNotice] = useState(null);
  const [importing, setImporting] = useState(false);
  const [autoDetecting, setAutoDetecting] = useState(false);
  const [autoDetected, setAutoDetected] = useState(false);
  const completedRefreshJobsRef = useRef(new Set());
  const previousSuccessCountRef = useRef(0);
  const resumeJobId = isOpen
    ? (initialJobId || (typeof window !== "undefined"
      ? window.localStorage.getItem(BULK_JOB_STORAGE_KEY)
      : null))
    : null;
  const effectiveSelectedMethod = selectedMethod || (resumeJobId ? "import" : null);
  const effectiveImportMode = effectiveSelectedMethod === "import" && resumeJobId && !selectedMethod
    ? "bulk-account"
    : importMode;

  useEffect(() => {
    if (!isOpen) return;
    if (!initialSelectedMethod) return;
    setSelectedMethod(initialSelectedMethod);
    setImportMode(initialImportMode || "single-token");
    setBulkResult(null);
    setError(null);
  }, [initialFlowKey, initialImportMode, initialSelectedMethod, isOpen]);

  // Load proxy pools for bulk-account proxy selection
  useEffect(() => {
    if (!isOpen || effectiveImportMode !== "bulk-account") return;
    let cancelled = false;
    fetch("/api/proxy-pools?isActive=true", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : []))
      .then((pools) => { if (!cancelled) setProxyPools(Array.isArray(pools) ? pools : []); })
      .catch(() => { if (!cancelled) setProxyPools([]); });
    return () => { cancelled = true; };
  }, [isOpen, effectiveImportMode]);

  const playableProxyPools = useMemo(
    () => proxyPools.filter((pool) => (
      pool?.isActive === true
      && PLAYWRIGHT_PROXY_POOL_TYPES.has(String(pool.type || "http").toLowerCase())
    )),
    [proxyPools]
  );

  useEffect(() => {
    if (effectiveSelectedMethod !== "import" || effectiveImportMode !== "single-token" || !isOpen) return;

    const autoDetect = async () => {
      setAutoDetecting(true);
      setError(null);
      setAutoDetected(false);
      setIdcCredentials(null);

      try {
        const res = await fetch("/api/oauth/kiro/auto-import");
        const data = await res.json();

        if (data.found) {
          setRefreshToken(data.refreshToken);
          setAutoDetected(true);
          // Store IDC/organization credentials if present
          if (data.clientId && data.clientSecret) {
            setIdcCredentials({
              clientId: data.clientId,
              clientSecret: data.clientSecret,
              region: data.region,
              authMethod: data.authMethod,
              profileArn: data.profileArn,
            });
          }
        } else {
          setError(data.error || "Could not auto-detect token");
        }
      } catch {
        setError("Failed to auto-detect token");
      } finally {
        setAutoDetecting(false);
      }
    };

    autoDetect();
  }, [effectiveSelectedMethod, effectiveImportMode, isOpen]);

  useEffect(() => {
    if (!isOpen || effectiveSelectedMethod !== "import" || effectiveImportMode !== "bulk-account") return undefined;

    const restoreJob = async () => {
      if (activeJob?.jobId) return;

      try {
        setJobRestoreNotice(null);

        const preferredJobId = initialJobId || null;
        if (preferredJobId) {
          const preferred = await fetchBulkJobById(preferredJobId);
          if (preferred.res.ok && preferred.data?.job) {
            setActiveJob(preferred.data.job);
            return;
          }
        }

        const latest = await fetchLatestBulkJob();
        if (latest.res.ok && latest.data?.job) {
          setActiveJob(latest.data.job);
          if (typeof window !== "undefined") {
            window.localStorage.setItem(BULK_JOB_STORAGE_KEY, latest.data.job.jobId);
          }
          return;
        }

        if (resumeJobId) {
          const stored = await fetchBulkJobById(resumeJobId);
          if (stored.res.ok && stored.data?.job && isJobActive(stored.data.job.status)) {
            setActiveJob(stored.data.job);
            return;
          }

          if (typeof window !== "undefined") {
            window.localStorage.removeItem(BULK_JOB_STORAGE_KEY);
          }
          onBulkJobChange?.(null);
          setJobRestoreNotice(JOB_SESSION_EXPIRED_MESSAGE);
        }
      } catch {
        setJobRestoreNotice(JOB_SESSION_EXPIRED_MESSAGE);
      }
    };

    void restoreJob();
  }, [activeJob?.jobId, effectiveImportMode, effectiveSelectedMethod, initialJobId, isOpen, onBulkJobChange, resumeJobId]);

  useEffect(() => {
    if (!activeJob?.jobId) {
      previousSuccessCountRef.current = 0;
      return;
    }

    const currentSuccessCount = activeJob.summary?.success || 0;
    if (currentSuccessCount > previousSuccessCountRef.current) {
      onImportSuccess?.();
    }
    previousSuccessCountRef.current = currentSuccessCount;
  }, [activeJob, onImportSuccess]);

  useEffect(() => {
    if (!activeJob?.jobId) {
      return;
    }

    if (typeof window !== "undefined") {
      window.localStorage.setItem(BULK_JOB_STORAGE_KEY, activeJob.jobId);
    }
    onBulkJobChange?.(activeJob);
  }, [activeJob, onBulkJobChange]);

  useEffect(() => {
    if (!isOpen || !activeJob?.jobId || isJobTerminal(activeJob.status)) return undefined;

    const interval = window.setInterval(async () => {
      try {
        const current = await fetchBulkJobById(activeJob.jobId);
        if (current.res.ok && current.data?.job) {
          setJobRestoreNotice(null);
          setActiveJob(current.data.job);
          return;
        }

        if (current.res.status === 404) {
          const latest = await fetchLatestBulkJob();
          if (latest.res.ok && latest.data?.job) {
            setJobRestoreNotice(null);
            setActiveJob(latest.data.job);
            if (typeof window !== "undefined") {
              window.localStorage.setItem(BULK_JOB_STORAGE_KEY, latest.data.job.jobId);
            }
            return;
          }

          if (typeof window !== "undefined") {
            window.localStorage.removeItem(BULK_JOB_STORAGE_KEY);
          }
          onBulkJobChange?.(null);
          setActiveJob(null);
          setJobRestoreNotice("Bulk import progress expired or was cleared.");
        }
      } catch {
        // Keep last-known UI state and let user retry/cancel manually.
      }
    }, 1500);

    return () => window.clearInterval(interval);
  }, [activeJob?.jobId, activeJob?.status, isOpen, onBulkJobChange]);

  useEffect(() => {
    if (!isOpen || effectiveImportMode !== "bulk-account" || !activeJob?.jobId || !isJobTerminal(activeJob.status)) {
      return;
    }

    if ((activeJob.summary?.success || 0) <= 0) return;
    if (completedRefreshJobsRef.current.has(activeJob.jobId)) return;

    completedRefreshJobsRef.current.add(activeJob.jobId);
    onImportSuccess?.();
  }, [activeJob, effectiveImportMode, isOpen, onImportSuccess]);

  const runningBulkAccountJob = effectiveImportMode === "bulk-account" && activeJob && !isJobTerminal(activeJob.status);
  const finishedBulkAccountJob = effectiveImportMode === "bulk-account" && activeJob && isJobTerminal(activeJob.status);

  const summaryItems = useMemo(() => {
    if (!activeJob?.summary) return [];
    return [
      ["Total", activeJob.summary.total],
      ["Queued", activeJob.summary.queued],
      ["Running", activeJob.summary.running],
      ["Success", activeJob.summary.success],
      ["Skipped", activeJob.summary.skipped || 0],
      ["Failed", activeJob.summary.failed],
      ["Manual", activeJob.summary.needs_manual],
    ];
  }, [activeJob]);

  const activityItems = useMemo(
    () => (Array.isArray(activeJob?.activity) ? [...activeJob.activity].reverse() : []),
    [activeJob]
  );
  const groupedAccounts = useMemo(
    () => groupAccountsByStatus(activeJob?.accounts || []),
    [activeJob]
  );

  const spotlightAccount = useMemo(() => {
    if (!activeJob?.accounts?.length) return null;
    return activeJob.accounts.find((account) => account.status === "running")
      || activeJob.accounts.find((account) => account.status === "needs_manual")
      || activeJob.accounts.find((account) => account.status === "success")
      || activeJob.accounts[0];
  }, [activeJob]);

  const handleMethodSelect = (method) => {
    setSelectedMethod(method);
    setError(null);
  };

  const resetImportState = () => {
    setRefreshToken("");
    setBulkText("");
    setBulkResult(null);
    setConcurrency(String(DEFAULT_CONCURRENCY));
    setError(null);
    setJobRestoreNotice(null);
    setAutoDetected(false);
    setActiveJob(null);
    previousSuccessCountRef.current = 0;
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(BULK_JOB_STORAGE_KEY);
    }
    onBulkJobChange?.(null);
  };

  const handleBack = () => {
    if (runningBulkAccountJob) {
      onClose?.();
      return;
    }
    setSelectedMethod(null);
    setImportMode("single-token");
    resetImportState();
  };

  const handleImportToken = async () => {
    if (!refreshToken.trim()) {
      setError("Please enter a refresh token");
      return;
    }

    setImporting(true);
    setError(null);

    try {
      const res = await fetch("/api/oauth/kiro/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "token",
          refreshToken: refreshToken.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Import failed");
      }

      onImportSuccess?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  const handleBulkTokenImport = async (lines) => {
    const res = await fetch("/api/oauth/kiro/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "token",
        refreshTokens: lines,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Bulk import failed");
    }

    setBulkResult({
      success: data.imported || 0,
      failed: data.failed || 0,
    });

    onImportSuccess?.();
  };

  const handleBulkAccountImport = async (lines) => {
    const res = await fetch("/api/oauth/kiro/bulk-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accounts: lines,
        concurrency: Number.parseInt(concurrency, 10) || DEFAULT_CONCURRENCY,
        automationProxy: {
          mode: proxyMode,
          proxyPoolId: proxyMode === "selected" ? selectedProxyPoolId : "",
        },
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      const invalidHint = Array.isArray(data.invalidLines) && data.invalidLines.length > 0
        ? ` Invalid lines: ${data.invalidLines.join(", ")}`
        : "";
      throw new Error((data.error || "Bulk account import failed") + invalidHint);
    }

    setActiveJob(data.job || null);
    setJobRestoreNotice(null);
    if (data.job?.jobId) {
      completedRefreshJobsRef.current.delete(data.job.jobId);
    }
    setBulkResult(null);
  };

  const handleBulkImport = async () => {
    const lines = bulkText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) {
      setError(
        effectiveImportMode === "bulk-account"
          ? "Please enter at least one gmail|password line"
          : "Please enter at least one refresh token line"
      );
      return;
    }

    setImporting(true);
    setError(null);
    setBulkResult(null);

    try {
      if (effectiveImportMode === "bulk-account") {
        await handleBulkAccountImport(lines);
      } else {
        await handleBulkTokenImport(lines);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  const handleCancelJob = async () => {
    if (!activeJob?.jobId) return;

    try {
      const res = await fetch(`/api/oauth/kiro/bulk-import/${activeJob.jobId}/cancel`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to cancel job");
      }
      if (data.job) setActiveJob(data.job);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDoneRefresh = () => {
    resetImportState();
    onImportSuccess?.();
  };

  const handleOpenManualSession = async (workerId) => {
    if (!activeJob?.jobId || !workerId) return;

    try {
      const res = await fetch(`/api/oauth/kiro/bulk-import/${activeJob.jobId}/manual/${workerId}`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to open manual session");
      }
      if (data.job) setActiveJob(data.job);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleIdcContinue = () => {
    if (!idcStartUrl.trim()) {
      setError("Please enter your IDC start URL");
      return;
    }

    onMethodSelect("idc", { startUrl: idcStartUrl.trim(), region: idcRegion });
  };

  const handleSocialLogin = (provider) => {
    onMethodSelect("social", { provider });
  };

  return (
    <Modal
      isOpen={isOpen}
      title="Connect Kiro"
      onClose={onClose}
      size="full"
      className="max-w-[min(96vw,1540px)]"
    >
      <div className="flex flex-col gap-4">
        {!effectiveSelectedMethod && (
          <div className="space-y-3">
            <p className="mb-4 text-sm text-text-muted">
              Choose your authentication method:
            </p>

            <button
              onClick={() => onMethodSelect("builder-id")}
              className="w-full rounded-lg border border-border p-4 text-left transition-colors hover:bg-sidebar"
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined mt-0.5 text-primary">shield</span>
                <div className="flex-1">
                  <h3 className="mb-1 font-semibold">AWS Builder ID</h3>
                  <p className="text-sm text-text-muted">
                    Recommended for most users. Free AWS account required.
                  </p>
                </div>
              </div>
            </button>

            <button
              onClick={() => handleMethodSelect("idc")}
              className="w-full rounded-lg border border-border p-4 text-left transition-colors hover:bg-sidebar"
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined mt-0.5 text-primary">business</span>
                <div className="flex-1">
                  <h3 className="mb-1 font-semibold">AWS IAM Identity Center</h3>
                  <p className="text-sm text-text-muted">
                    For enterprise users with custom AWS IAM Identity Center.
                  </p>
                </div>
              </div>
            </button>

            <button
              onClick={() => handleMethodSelect("social-google")}
              className="hidden w-full rounded-lg border border-border p-4 text-left transition-colors hover:bg-sidebar"
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined mt-0.5 text-primary">account_circle</span>
                <div className="flex-1">
                  <h3 className="mb-1 font-semibold">Google Account</h3>
                  <p className="text-sm text-text-muted">
                    Login with your Google account (manual callback).
                  </p>
                </div>
              </div>
            </button>

            <button
              onClick={() => handleMethodSelect("social-github")}
              className="hidden w-full rounded-lg border border-border p-4 text-left transition-colors hover:bg-sidebar"
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined mt-0.5 text-primary">code</span>
                <div className="flex-1">
                  <h3 className="mb-1 font-semibold">GitHub Account</h3>
                  <p className="text-sm text-text-muted">
                    Login with your GitHub account (manual callback).
                  </p>
                </div>
              </div>
            </button>

            <button
              onClick={() => handleMethodSelect("import")}
              className="w-full rounded-lg border border-border p-4 text-left transition-colors hover:bg-sidebar"
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined mt-0.5 text-primary">file_upload</span>
                <div className="flex-1">
                  <h3 className="mb-1 font-semibold">Bulk Option</h3>
                  <p className="text-sm text-text-muted">
                    Import a single token, bulk tokens, or bulk Google accounts.
                  </p>
                </div>
              </div>
            </button>

            {/* Import CLIProxyAPI JSON */}
            <button
              onClick={() => handleMethodSelect("import-cli-proxy")}
              className="w-full p-4 text-left border border-border rounded-lg hover:bg-sidebar transition-colors"
            >
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-primary mt-0.5">data_object</span>
                <div className="flex-1">
                  <h3 className="font-semibold mb-1">Import CLIProxyAPI JSON</h3>
                  <p className="text-sm text-text-muted">
                    Paste external_idp auth JSON from CLIProxyAPI/Kiro Microsoft login.
                  </p>
                </div>
              </div>
            </button>
          </div>
        )}

        {effectiveSelectedMethod === "idc" && (
          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-sm font-medium">
                IDC Start URL <span className="text-red-500">*</span>
              </label>
              <Input
                value={idcStartUrl}
                onChange={(e) => setIdcStartUrl(e.target.value)}
                placeholder="https://your-org.awsapps.com/start"
                className="font-mono text-sm"
              />
              <p className="mt-1 text-xs text-text-muted">
                Your organization&apos;s AWS IAM Identity Center URL
              </p>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">
                AWS Region
              </label>
              <Input
                value={idcRegion}
                onChange={(e) => setIdcRegion(e.target.value)}
                placeholder="us-east-1"
                className="font-mono text-sm"
              />
              <p className="mt-1 text-xs text-text-muted">
                AWS region for your Identity Center (default: us-east-1)
              </p>
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <div className="flex gap-2">
              <Button onClick={handleIdcContinue} fullWidth>
                Continue
              </Button>
              <Button onClick={handleBack} variant="ghost" fullWidth>
                Back
              </Button>
            </div>
          </div>
        )}

        {effectiveSelectedMethod === "social-google" && (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
              <div className="flex gap-2">
                <span className="material-symbols-outlined text-amber-600 dark:text-amber-400">info</span>
                <div className="flex-1 text-sm">
                  <p className="mb-1 font-medium text-amber-900 dark:text-amber-100">
                    Manual Callback Required
                  </p>
                  <p className="text-amber-800 dark:text-amber-200">
                    After login, you&apos;ll need to copy the callback URL from your browser and paste it back here.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={() => handleSocialLogin("google")} fullWidth>
                Continue with Google
              </Button>
              <Button onClick={handleBack} variant="ghost" fullWidth>
                Back
              </Button>
            </div>
          </div>
        )}

        {effectiveSelectedMethod === "social-github" && (
          <div className="space-y-4">
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/20">
              <div className="flex gap-2">
                <span className="material-symbols-outlined text-amber-600 dark:text-amber-400">info</span>
                <div className="flex-1 text-sm">
                  <p className="mb-1 font-medium text-amber-900 dark:text-amber-100">
                    Manual Callback Required
                  </p>
                  <p className="text-amber-800 dark:text-amber-200">
                    After login, you&apos;ll need to copy the callback URL from your browser and paste it back here.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={() => handleSocialLogin("github")} fullWidth>
                Continue with GitHub
              </Button>
              <Button onClick={handleBack} variant="ghost" fullWidth>
                Back
              </Button>
            </div>
          </div>
        )}

        {effectiveSelectedMethod === "import" && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant={effectiveImportMode === "single-token" ? "primary" : "ghost"}
                onClick={() => {
                  setImportMode("single-token");
                  setBulkResult(null);
                  setError(null);
                }}
                disabled={runningBulkAccountJob}
              >
                Single Token
              </Button>
              <Button
                size="sm"
                variant={effectiveImportMode === "bulk-token" ? "primary" : "ghost"}
                onClick={() => {
                  setImportMode("bulk-token");
                  setBulkResult(null);
                  setError(null);
                }}
                disabled={runningBulkAccountJob}
              >
                Bulk Token
              </Button>
              <Button
                size="sm"
                variant={effectiveImportMode === "bulk-account" ? "primary" : "ghost"}
                onClick={() => {
                  setImportMode("bulk-account");
                  setBulkResult(null);
                  setError(null);
                }}
              >
                Bulk Account
              </Button>
            </div>

            {effectiveImportMode === "single-token" && (
              <>
                {autoDetecting && (
                  <div className="py-6 text-center">
                    <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-full bg-primary/10">
                      <span className="material-symbols-outlined animate-spin text-3xl text-primary">
                        progress_activity
                      </span>
                    </div>
                    <h3 className="mb-2 text-lg font-semibold">Auto-detecting token...</h3>
                    <p className="text-sm text-text-muted">Reading from AWS SSO cache</p>
                  </div>
                )}

                {!autoDetecting && (
                  <>
                    {autoDetected && (
                      <div className="rounded-lg border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-900/20">
                        <div className="flex gap-2">
                          <span className="material-symbols-outlined text-green-600 dark:text-green-400">check_circle</span>
                          <p className="text-sm text-green-800 dark:text-green-200">
                            Token auto-detected from Kiro IDE successfully!
                          </p>
                        </div>
                      </div>
                    )}

                    {!autoDetected && !error && (
                      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-900/20">
                        <div className="flex gap-2">
                          <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">info</span>
                          <p className="text-sm text-blue-800 dark:text-blue-200">
                            Kiro IDE not detected. Please paste your refresh token manually.
                          </p>
                        </div>
                      </div>
                    )}

                    <div>
                      <label className="mb-2 block text-sm font-medium">
                        Refresh Token <span className="text-red-500">*</span>
                      </label>
                      <Input
                        value={refreshToken}
                        onChange={(e) => setRefreshToken(e.target.value)}
                        placeholder="Token will be auto-filled..."
                        className="font-mono text-sm"
                      />
                    </div>

                    {error && (
                      <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20">
                        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                      </div>
                    )}

                    <div className="flex gap-2">
                      <Button onClick={handleImportToken} fullWidth disabled={importing || !refreshToken.trim()}>
                        {importing ? "Importing..." : "Import Token"}
                      </Button>
                      <Button onClick={handleBack} variant="ghost" fullWidth>
                        Back
                      </Button>
                    </div>
                  </>
                )}
              </>
            )}

            {effectiveImportMode === "bulk-token" && (
              <>
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-900/20">
                  <div className="flex gap-2">
                    <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">info</span>
                    <p className="text-sm text-blue-800 dark:text-blue-200">
                      Bulk token import accepts one refresh token per line.
                    </p>
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-medium">
                    Bulk Refresh Tokens <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    value={bulkText}
                    onChange={(e) => setBulkText(e.target.value)}
                    placeholder={"aorAAAAAG...\naorAAAAAG..."}
                    className="min-h-[160px] w-full resize-y rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <p className="mt-1 text-xs text-text-muted">
                    One refresh token per line.
                  </p>
                </div>

                {bulkResult && (
                  <div className={`text-sm font-medium ${bulkResult.failed > 0 ? "text-yellow-600 dark:text-yellow-400" : "text-green-600 dark:text-green-400"}`}>
                    {`Success: ${bulkResult.success} imported${bulkResult.failed > 0 ? `, ${bulkResult.failed} failed` : ""}`}
                  </div>
                )}

                {error && (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20">
                    <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                  </div>
                )}

                {jobRestoreNotice && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-900/20">
                    <p className="text-sm text-amber-700 dark:text-amber-300">{jobRestoreNotice}</p>
                  </div>
                )}

                <div className="flex gap-2">
                  <Button onClick={handleBulkImport} fullWidth disabled={importing || !bulkText.trim()}>
                    {importing ? "Importing..." : "Import Tokens"}
                  </Button>
                  <Button onClick={handleBack} variant="ghost" fullWidth>
                    Back
                  </Button>
                </div>
              </>
            )}

            {effectiveImportMode === "bulk-account" && (
              <>
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-900/20">
                  <div className="flex gap-2">
                    <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">info</span>
                    <p className="text-sm text-blue-800 dark:text-blue-200">
                      Bulk account import runs Playwright in the background, keeps passwords in memory only, and only needs manual action when Google or Kiro blocks a worker. Recommended worker count for a 24 GB machine: 4.
                    </p>
                  </div>
                </div>

                {!activeJob && (
                  <>
                    <div>
                      <label className="mb-2 block text-sm font-medium">
                        Bulk Accounts <span className="text-red-500">*</span>
                      </label>
                      <textarea
                        value={bulkText}
                        onChange={(e) => setBulkText(e.target.value)}
                        placeholder={"gmail1@example.com|password1\ngmail2@example.com|password2"}
                        className="min-h-[180px] w-full resize-y rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                      <p className="mt-1 text-xs text-text-muted">
                        One account per line in the format gmail|password.
                      </p>
                    </div>

                    <div>
                      <label className="mb-2 block text-sm font-medium">
                        Concurrent Workers
                      </label>
                      <Input
                        type="number"
                        min="1"
                        max="8"
                        value={concurrency}
                        onChange={(e) => setConcurrency(e.target.value)}
                        placeholder="4"
                      />
                      <p className="mt-1 text-xs text-text-muted">
                        Default 4. Allowed range: 1 to 8 workers.
                      </p>
                    </div>

                    <div className="rounded-xl border border-border bg-sidebar/60 p-4">
                      <label htmlFor="kiro-bulk-proxy-mode" className="mb-2 block text-sm font-medium">OAuth Browser Proxy</label>
                      <select
                        id="kiro-bulk-proxy-mode"
                        value={proxyMode}
                        onChange={(e) => setProxyMode(e.target.value)}
                        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
                      >
                        <option value="active-round-robin">Round-robin all active proxy pools</option>
                        <option value="selected">Use one selected proxy pool</option>
                        <option value="profile">Use profile outbound proxy</option>
                        <option value="none">No proxy / direct browser</option>
                      </select>

                      {proxyMode === "selected" && (
                        <select
                          aria-label="Selected OAuth proxy pool"
                          value={selectedProxyPoolId}
                          onChange={(e) => setSelectedProxyPoolId(e.target.value)}
                          className="mt-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-main focus:outline-none focus:ring-1 focus:ring-primary"
                        >
                          <option value="">Select proxy pool</option>
                          {playableProxyPools.map((pool) => (
                            <option key={pool.id} value={pool.id}>{pool.name}</option>
                          ))}
                        </select>
                      )}

                      <p className="mt-2 text-xs text-text-muted">
                        Default rotates browser OAuth workers across active HTTP/SOCKS proxy pools from /dashboard/proxy-pools.
                      </p>
                      {proxyMode === "active-round-robin" && (
                        <p className="mt-1 text-xs text-text-muted">
                          Available browser proxy pools: {playableProxyPools.length}. Accounts are assigned by line number for stable round-robin rotation.
                        </p>
                      )}
                      {proxyMode === "selected" && playableProxyPools.length === 0 && (
                        <p className="mt-1 text-xs text-amber-500">
                          No active HTTP/SOCKS proxy pools found. Add one in /dashboard/proxy-pools or choose another mode.
                        </p>
                      )}
                    </div>
                  </>
                )}

                {activeJob && (
                  <div className="space-y-4 rounded-xl border border-border p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h3 className="font-semibold">Bulk Import Job</h3>
                        <p className="text-xs text-text-muted">
                          Job ID: <span className="font-mono">{activeJob.jobId}</span>
                        </p>
                        <p className="text-xs text-text-muted">
                          Status: <span className="font-medium">{activeJob.status}</span> | Workers: {activeJob.concurrency}
                        </p>
                        <p className="text-xs text-text-muted">
                          Browser workers run in the background. Close this modal if needed and reopen it later from the provider page with Resume Bulk Progress.
                        </p>
                      </div>
                      <div className="flex gap-2">
                        {runningBulkAccountJob && (
                          <Button size="sm" variant="secondary" onClick={handleCancelJob}>
                            Cancel Job
                          </Button>
                        )}
                        {finishedBulkAccountJob && (
                          <Button size="sm" onClick={handleDoneRefresh}>
                            Done & Refresh
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                      {summaryItems.map(([label, value]) => (
                        <div key={label} className="rounded-lg bg-sidebar px-3 py-2">
                          <p className="text-[11px] uppercase tracking-wide text-text-muted">{label}</p>
                          <p className="text-lg font-semibold">{value}</p>
                        </div>
                      ))}
                    </div>

                    {activeJob.error && (
                      <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
                        {activeJob.error}
                      </div>
                    )}

                    {activeJob.summary?.needs_manual > 0 && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
                        Some accounts need manual assist. Open the blocked worker session below, finish the Google or Kiro prompts, and the job will continue updating automatically.
                      </div>
                    )}

                    <div className="grid gap-4 lg:grid-cols-[minmax(0,7fr)_minmax(320px,3fr)]">
                      <div className="space-y-4">
                        <div className="overflow-hidden rounded-xl border border-border bg-sidebar">
                          <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                              <p className="text-sm font-semibold">Live Browser Preview</p>
                              <p className="text-xs text-text-muted">
                                {activeJob.preview?.email || spotlightAccount?.email || "Waiting for worker"}
                                {activeJob.preview?.workerId ? ` | Worker ${activeJob.preview.workerId}` : ""}
                              </p>
                            </div>
                            <div className="text-right text-xs text-text-muted">
                              <p>{formatStepLabel(activeJob.preview?.step || spotlightAccount?.currentStep)}</p>
                              <p>Updated {formatClock(activeJob.preview?.updatedAt || spotlightAccount?.updatedAt)}</p>
                            </div>
                          </div>

                          <div className="relative bg-black/90">
                            {activeJob.preview?.imageData ? (
                              <Image
                                src={activeJob.preview.imageData}
                                alt={`Live worker preview for ${activeJob.preview.email || "Kiro import"}`}
                                width={1440}
                                height={900}
                                unoptimized
                                className="h-[420px] w-full object-contain"
                              />
                            ) : (
                              <div className="flex h-[420px] flex-col items-center justify-center gap-3 px-6 text-center text-slate-200">
                                <span className="material-symbols-outlined text-5xl text-primary/80">browser_updated</span>
                                <div>
                                  <p className="text-base font-medium">Preview will appear when a worker opens Google or Kiro</p>
                                  <p className="mt-1 text-sm text-slate-400">
                                    The import keeps running in the background even if the screenshot is not available yet.
                                  </p>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="space-y-4">
                          {groupedAccounts.map((group) => (
                            <div key={group.status} className={`rounded-xl border p-4 ${getStatusPanelClasses(group.status)}`}>
                              <div className="mb-3 flex items-center justify-between gap-3">
                                <div className="flex items-center gap-2">
                                  <AccountStatusBadge status={group.status} />
                                  <p className="text-sm font-semibold capitalize">{formatStepLabel(group.status)}</p>
                                </div>
                                <p className="text-xs text-text-muted">{group.accounts.length} account{group.accounts.length > 1 ? "s" : ""}</p>
                              </div>

                              <div className="grid gap-3 xl:grid-cols-2">
                                {group.accounts.map((account) => (
                                  <div key={`${account.email}-${account.line}`} className="rounded-xl border border-border bg-background/80 p-4">
                                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                                      <div className="min-w-0">
                                        <p className="truncate text-sm font-semibold">{account.email}</p>
                                        <p className="text-[11px] text-text-muted">
                                          Line {account.line}{account.workerId ? ` | Worker ${account.workerId}` : ""} | {formatClock(account.updatedAt)}
                                        </p>
                                      </div>
                                      <AccountStatusBadge status={account.status} />
                                    </div>

                                    <div className="mt-3 rounded-lg border border-border/70 bg-sidebar/70 px-3 py-2">
                                      <p className="text-[11px] uppercase tracking-wide text-text-muted">Current Step</p>
                                      <p className="mt-1 text-sm font-medium capitalize">{formatStepLabel(account.currentStep)}</p>
                                    </div>

                                    {account.logs?.length > 0 && (
                                      <div className="mt-3 space-y-2">
                                        {account.logs.slice(-3).reverse().map((entry) => (
                                          <div key={entry.id} className="rounded-lg bg-sidebar/60 px-3 py-2">
                                            <div className="flex items-center justify-between gap-3">
                                              <p className="text-xs font-medium capitalize">{formatStepLabel(entry.step)}</p>
                                              <span className="text-[11px] text-text-muted">{formatClock(entry.at)}</span>
                                            </div>
                                            <p className="mt-1 text-xs text-text-muted">{entry.message}</p>
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {account.error && (
                                      <p className="mt-3 text-xs text-red-500">{account.error}</p>
                                    )}

                                    {account.manualSessionAvailable && account.workerId ? (
                                      <div className="mt-3 flex items-center gap-2">
                                        <Button
                                          size="sm"
                                          variant={account.manualSessionOpened ? "secondary" : "primary"}
                                          onClick={() => handleOpenManualSession(account.workerId)}
                                        >
                                          {account.manualSessionOpened ? "Re-open Manual Session" : "Open Manual Session"}
                                        </Button>
                                        <p className="text-[11px] text-text-muted">
                                          Open only if this worker is blocked by CAPTCHA, 2FA, or recovery prompts.
                                        </p>
                                      </div>
                                    ) : null}
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="rounded-xl border border-border bg-sidebar/70">
                        <div className="border-b border-border px-4 py-3">
                          <p className="text-sm font-semibold">Live Activity Log</p>
                          <p className="text-xs text-text-muted">
                            Every worker step is recorded here in near real time.
                          </p>
                        </div>
                        <div className="max-h-[720px] space-y-3 overflow-y-auto p-4">
                          {activityItems.length === 0 && (
                            <div className="rounded-lg bg-background/70 px-3 py-4 text-sm text-text-muted">
                              Waiting for the first worker event...
                            </div>
                          )}
                          {activityItems.map((entry) => (
                            <div key={entry.id} className="rounded-lg border border-border/70 bg-background/80 px-3 py-3">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-semibold">{entry.email}</p>
                                  <p className="text-[11px] text-text-muted">
                                    {entry.workerId ? `Worker ${entry.workerId}` : "Waiting"} | {formatStepLabel(entry.step)}
                                  </p>
                                </div>
                                <span className="shrink-0 text-[11px] text-text-muted">{formatClock(entry.at)}</span>
                              </div>
                              <p className="mt-2 text-xs text-text-muted">{entry.message}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {error && (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20">
                    <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                  </div>
                )}

                <div className="flex gap-2">
                  {!activeJob && (
                    <Button onClick={handleBulkImport} fullWidth disabled={importing || !bulkText.trim() || (proxyMode === "selected" && !selectedProxyPoolId)}>
                      {importing ? "Starting..." : "Start Bulk Import"}
                    </Button>
                  )}
                  {activeJob && !finishedBulkAccountJob && (
                    <Button onClick={handleCancelJob} fullWidth variant="secondary" disabled={!runningBulkAccountJob}>
                      {runningBulkAccountJob ? "Cancel Running Job" : "Job Stopped"}
                    </Button>
                  )}
                  {finishedBulkAccountJob && (
                    <Button onClick={handleDoneRefresh} fullWidth>
                      Done & Refresh Connections
                    </Button>
                  )}
                  <Button onClick={handleBack} variant="ghost" fullWidth>
                    {activeJob ? "Back" : "Cancel"}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {/* Import CLIProxyAPI JSON */}
        {selectedMethod === "import-cli-proxy" && (
          <div className="space-y-4">
            <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg border border-blue-200 dark:border-blue-800">
              <div className="flex gap-2">
                <span className="material-symbols-outlined text-blue-600 dark:text-blue-400">info</span>
                <p className="text-sm text-blue-800 dark:text-blue-200">
                  Paste the Kiro CLIProxyAPI auth JSON containing auth_method=external_idp. Only Microsoft login token endpoints are accepted.
                </p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">
                CLIProxyAPI Auth JSON <span className="text-red-500">*</span>
              </label>
              <textarea
                value={cliProxyJson}
                onChange={(e) => setCliProxyJson(e.target.value)}
                placeholder={'{"auth_method":"external_idp","access_token":"...","refresh_token":"...","client_id":"...","token_endpoint":"https://login.microsoftonline.com/.../oauth2/v2.0/token","profile_arn":"...","scopes":"..."}'}
                className="min-h-40 w-full rounded-md border border-border bg-background p-3 font-mono text-sm outline-none focus:border-primary"
              />
            </div>

            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-lg border border-red-200 dark:border-red-800">
                <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
              </div>
            )}

            <div className="flex gap-2">
              <Button onClick={handleImportCliProxyJson} fullWidth disabled={importing || !cliProxyJson.trim()}>
                {importing ? "Importing..." : "Import CLIProxyAPI JSON"}
              </Button>
              <Button onClick={handleBack} variant="ghost" fullWidth>
                Back
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

KiroAuthModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onMethodSelect: PropTypes.func.isRequired,
  onImportSuccess: PropTypes.func,
  initialJobId: PropTypes.string,
  initialSelectedMethod: PropTypes.string,
  initialImportMode: PropTypes.string,
  initialFlowKey: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  onBulkJobChange: PropTypes.func,
  onClose: PropTypes.func.isRequired,
};
