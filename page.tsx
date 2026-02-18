"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getRiskColor, getRiskBgRgba } from "./utils/riskColors";

// Mock data — replace with real API later
const MOCK_BTC_PRICE_USD = 103420;
const MOCK_BTC_24H_CHANGE = 2.14;
const USD_TO_AUD = 1.55;
const RISK_VALUE = 64;
const MOCK_LAST_UPDATED = "Updated today";

const COUNT_DURATION_MS = 1200;

const FREQUENCY_OPTIONS = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "fortnightly", label: "Fortnightly" },
  { value: "monthly", label: "Monthly" },
] as const;

function getIntervalsPerYear(freq: string): number {
  switch (freq) {
    case "daily": return 365;
    case "weekly": return 52;
    case "fortnightly": return 26;
    case "monthly": return 12;
    default: return 52;
  }
}

// Placeholder: risk band 0–100 in steps of 10 → BTC price (mock)
function getMockBtcPriceForRisk(risk: number): number {
  const base = MOCK_BTC_PRICE_USD;
  const factor = 1 + (risk / 100) * 0.8;
  return Math.round(base * factor);
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

type MockExecution = {
  id: string;
  date: string;
  riskAtExecution: number;
  amountFiat: number;
  btcAmount: number;
  pricePerBtc: number;
};

type SavedStrategy = {
  id: string;
  name: string;
  mode: "accumulate" | "distribute";
  strategyType: "fixed" | "dynamic";
  type: "fixed" | "scaled";
  side: "buy" | "sell";
  triggerMode: "schedule" | "risk-step";
  threshold: number;
  frequency?: "daily" | "weekly" | "fortnightly" | "monthly";
  amountPerPurchase: number;
  capital: number;
  btcHoldings?: number;
  alertsEnabled: boolean;
  active: boolean;
  createdAt: string;
  strategyStartDate?: string;
  activatedAt?: string;
  lastExecutionAt?: string;
  nextExecutionAt?: string;
  status: "Active" | "Waiting" | "Triggered" | "Completed" | "Paused";
  dynamicStepInterval?: number;
  dynamicMultiplierPct?: number;
  /** For scaled strategies: persisted risk levels + order sizes. Rendered from this; do not recompute on display. */
  computedOrders?: { risk: number; amountFiat: number }[];
  executions?: MockExecution[];
};

const SAVED_STRATEGIES_KEY = "csh-saved-strategies";

const RISK_BAND_ROW_HEIGHT = 36;
// Steps 0, 2.5, 5, 7.5, ... 100 (41 rows)
const RISK_BAND_VALUES = Array.from({ length: 41 }, (_, i) => i * 2.5);
const RISK_BAND_VISIBLE_EXTRA = 2;

function formatRiskValue(r: number): string {
  return r % 1 === 0 ? String(r) : String(r);
}

function loadSavedStrategies(): SavedStrategy[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(SAVED_STRATEGIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedStrategy[];
    const loaded = Array.isArray(parsed) ? parsed.map((p) => {
      const st = (p as SavedStrategy).strategyType ?? "fixed";
      return {
        ...p,
        active: p.active ?? false,
        strategyType: st,
        type: (p as SavedStrategy).type ?? (st === "fixed" ? "fixed" : "scaled"),
        side: (p as SavedStrategy).side ?? (p.mode === "accumulate" ? "buy" : "sell"),
        triggerMode: (p as SavedStrategy).triggerMode ?? (st === "fixed" ? "schedule" : "risk-step"),
        status: (p.status === "Paused" || !p.status ? "Waiting" : p.status) as SavedStrategy["status"],
        executions: p.executions ?? [],
      };
    }) : [];
    return loaded;
  } catch {
    return [];
  }
}

export default function Home() {
  const riskSectionRef = useRef<HTMLElement>(null);
  const dashboardSectionRef = useRef<HTMLElement>(null);
  const [riskSectionVisible, setRiskSectionVisible] = useState(false);
  const [dashboardVisible, setDashboardVisible] = useState(false);
  const [displayValue, setDisplayValue] = useState(0);
  const [countComplete, setCountComplete] = useState(false);

  const [currency, setCurrency] = useState<"USD" | "AUD">("USD");
  const [dashboardTab, setDashboardTab] = useState<"riskIndex" | "manualPlanner" | "savedPlan" | "backtest">("riskIndex");
  const [riskBandOpen, setRiskBandOpen] = useState(false);
  const [simulatedRisk, setSimulatedRisk] = useState(RISK_VALUE);
  const [dcaMode, setDcaMode] = useState<"accumulate" | "distribute" | null>(null);

  const [capital, setCapital] = useState(10000);
  const [buyThreshold, setBuyThreshold] = useState(30);
  const [sellThreshold, setSellThreshold] = useState(75);
  const [investPerInterval, setInvestPerInterval] = useState(1000);
  const [sellPerInterval, setSellPerInterval] = useState(500);
  const [btcHoldings, setBtcHoldings] = useState(0.5);
  const [frequency, setFrequency] = useState<"daily" | "weekly" | "fortnightly" | "monthly">("weekly");
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [weeklySummaryEnabled, setWeeklySummaryEnabled] = useState(false);
  const [notifyEmail, setNotifyEmail] = useState("");
  const [notifySubmitted, setNotifySubmitted] = useState(false);
  const [isLoggedIn] = useState(false);
  /** Access: free (no save/activate/Simulator), trial (full access), expired (view-only strategies) */
  const [accessLevel, setAccessLevel] = useState<"free" | "trial" | "expired">("free");
  const canSaveAndActivate = accessLevel === "trial";
  const canAccessSimulatorPro = accessLevel === "trial";
  const isViewOnlyExpired = accessLevel === "expired";
  const [savedPlans, setSavedPlans] = useState<SavedStrategy[]>(() => loadSavedStrategies());
  const [showSaveStrategyModal, setShowSaveStrategyModal] = useState(false);
  const [showUpdateConfirmModal, setShowUpdateConfirmModal] = useState(false);
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  const [strategyNameInput, setStrategyNameInput] = useState("");
  const [riskNumberHover, setRiskNumberHover] = useState(false);
  const [strategyType, setStrategyType] = useState<"fixed" | "dynamic" | null>(null);
  const [justSavedId, setJustSavedId] = useState<string | null>(null);
  const [expandedPlanId, setExpandedPlanId] = useState<string | null>(null);
  const [deploymentPlanOpenId, setDeploymentPlanOpenId] = useState<string | null>(null);
  const [lockingIn, setLockingIn] = useState(false);
  const [showLockInToast, setShowLockInToast] = useState(false);
  const [hasChosenMode, setHasChosenMode] = useState(false);
  const [hasChosenDcaType, setHasChosenDcaType] = useState(false);
  const [dynamicMultiplierPct, setDynamicMultiplierPct] = useState(25);
  const [dynamicStepInterval, setDynamicStepInterval] = useState(5);
  const [riskBandScrollTop, setRiskBandScrollTop] = useState(0);
  const [strategyHelpOpen, setStrategyHelpOpen] = useState<"fixed" | "scaled" | null>(null);
  const [tooltipAnchor, setTooltipAnchor] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [tooltipPlacement, setTooltipPlacement] = useState<"above" | "below">("above");
  const riskBandContainerRef = useRef<HTMLDivElement>(null);
  const savedCardRef = useRef<HTMLDivElement>(null);
  const strategyHelpAreaRef = useRef<HTMLDivElement>(null);
  const fixedHelpIconRef = useRef<HTMLSpanElement>(null);
  const scaledHelpIconRef = useRef<HTMLSpanElement>(null);
  const strategyTooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (justSavedId && dashboardTab === "savedPlan") {
      savedCardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [justSavedId, dashboardTab]);

  useEffect(() => {
    if (strategyHelpOpen === null) return;
    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      const inArea = strategyHelpAreaRef.current?.contains(target);
      const inTooltip = strategyTooltipRef.current?.contains(target);
      if (!inArea && !inTooltip) setStrategyHelpOpen(null);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("touchstart", handleClickOutside, { passive: true });
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, [strategyHelpOpen]);

  const updateTooltipAnchor = () => {
    const ref = strategyHelpOpen === "fixed" ? fixedHelpIconRef : strategyHelpOpen === "scaled" ? scaledHelpIconRef : null;
    if (!ref?.current || strategyHelpOpen === null) {
      setTooltipAnchor(null);
      return;
    }
    const rect = ref.current.getBoundingClientRect();
    setTooltipAnchor({ top: rect.top, left: rect.left, width: rect.width, height: rect.height });
    const spaceAbove = rect.top;
    const spaceBelow = typeof window !== "undefined" ? window.innerHeight - rect.bottom : 200;
    setTooltipPlacement(spaceAbove < 140 && spaceBelow > spaceAbove ? "below" : "above");
  };

  useEffect(() => {
    if (strategyHelpOpen === null) {
      setTooltipAnchor(null);
      return;
    }
    updateTooltipAnchor();
    window.addEventListener("scroll", updateTooltipAnchor, true);
    window.addEventListener("resize", updateTooltipAnchor);
    return () => {
      window.removeEventListener("scroll", updateTooltipAnchor, true);
      window.removeEventListener("resize", updateTooltipAnchor);
    };
  }, [strategyHelpOpen]);

  useEffect(() => {
    setStrategyHelpOpen(null);
  }, [dcaMode]);

  useEffect(() => {
    if (savedPlans.length === 0 && typeof window === "undefined") return;
    try {
      localStorage.setItem(SAVED_STRATEGIES_KEY, JSON.stringify(savedPlans));
    } catch {}
  }, [savedPlans]);

  useEffect(() => {
    setSavedPlans((prev) => {
      const next = prev.map((p) => {
        if (p.mode !== "distribute" || !p.active) return p;
        const sold = (p.executions ?? []).reduce((sum, e) => sum + e.btcAmount, 0);
        const remaining = Math.max(0, (p.btcHoldings ?? 0) - sold);
        if (remaining <= 0) return { ...p, active: false };
        return p;
      });
      const anyDeactivated = next.some((p, i) => p.active !== prev[i].active);
      return anyDeactivated ? next : prev;
    });
  }, [savedPlans]);

  useEffect(() => {
    function frequencyEngine(prev: SavedStrategy[]): SavedStrategy[] {
      const now = Date.now();
      const nowIso = new Date().toISOString();
      let changed = false;
      const next = prev.map((p) => {
        if (p.type !== "fixed") return p;
        const inZone = p.mode === "accumulate" ? RISK_VALUE <= p.threshold : RISK_VALUE >= p.threshold;
        if (!p.active || !p.frequency) return p;
        if (!inZone) {
          if (p.nextExecutionAt) {
            changed = true;
            return { ...p, nextExecutionAt: undefined };
          }
          return p;
        }
          const freqMs = getFrequencyIntervalMs(p.frequency);
          const nextDue = p.nextExecutionAt ? new Date(p.nextExecutionAt).getTime() : null;
          const shouldRun = nextDue == null || now >= nextDue;
          if (!shouldRun) return p;
          if (p.mode === "distribute") {
            const sold = (p.executions ?? []).reduce((s, e) => s + e.btcAmount, 0);
            const remaining = Math.max(0, (p.btcHoldings ?? 0) - sold);
            const price = getMockBtcPriceForRisk(RISK_VALUE);
            const btcNeeded = price > 0 ? p.amountPerPurchase / price : 0;
            if (btcNeeded > remaining) return p;
          }
          const price = getMockBtcPriceForRisk(RISK_VALUE);
          const btcAmount = price > 0 ? p.amountPerPurchase / price : 0;
          const newEx: MockExecution = {
            id: `exec-${now}-${p.id}`,
            date: nowIso.slice(0, 10),
            riskAtExecution: RISK_VALUE,
            amountFiat: p.amountPerPurchase,
            btcAmount,
            pricePerBtc: price,
          };
          changed = true;
          return {
            ...p,
            lastExecutionAt: nowIso,
            nextExecutionAt: new Date(now + freqMs).toISOString(),
            executions: [...(p.executions ?? []), newEx],
          };
      });
      return changed ? next : prev;
    }

    function levelCrossingEngine(prev: SavedStrategy[]): SavedStrategy[] {
      // Rule: when risk crosses multiple levels in one move, trigger all unfilled levels that were crossed (same for Buy and Sell).
      let changed = false;
      const next = prev.map((p) => {
        if (p.type !== "scaled" || !p.active) return p;
        const inZone = p.mode === "accumulate" ? RISK_VALUE <= p.threshold : RISK_VALUE >= p.threshold;
        if (!inZone) return p;
        const levels = getStrategyLevels(p);
        const executedByLevel = new Map<number, MockExecution>();
        (p.executions ?? []).forEach((ex) => {
          const closest = levels.reduce((a, b) => Math.abs(a - ex.riskAtExecution) <= Math.abs(b - ex.riskAtExecution) ? a : b);
          if (!executedByLevel.has(closest)) executedByLevel.set(closest, ex);
        });
        const crossedNotExecuted = p.mode === "accumulate"
          ? levels.filter((L) => RISK_VALUE <= L && !executedByLevel.has(L))
          : levels.filter((L) => RISK_VALUE >= L && !executedByLevel.has(L));
        if (crossedNotExecuted.length === 0) return p;
        if (p.mode === "distribute") {
          const sold = (p.executions ?? []).reduce((s, e) => s + e.btcAmount, 0);
          const remaining = Math.max(0, (p.btcHoldings ?? 0) - sold);
          if (remaining <= 0) return p;
        }
        const nowIso = new Date().toISOString();
        const newExecutions: MockExecution[] = [];
        for (const level of crossedNotExecuted) {
          const amountFiat = getAmountAtRisk(p, level);
          const price = getMockBtcPriceForRisk(level);
          const btcAmount = price > 0 ? amountFiat / price : 0;
          if (p.mode === "distribute") {
            const soldSoFar = (p.executions ?? []).reduce((s, e) => s + e.btcAmount, 0) + newExecutions.reduce((s, e) => s + e.btcAmount, 0);
            const remainingAfter = Math.max(0, (p.btcHoldings ?? 0) - soldSoFar - btcAmount);
            if (remainingAfter < 0) break;
          }
          newExecutions.push({
            id: `exec-${Date.now()}-${p.id}-${level}`,
            date: nowIso.slice(0, 10),
            riskAtExecution: level,
            amountFiat,
            btcAmount,
            pricePerBtc: price,
          });
        }
        if (newExecutions.length === 0) return p;
        changed = true;
        return { ...p, executions: [...(p.executions ?? []), ...newExecutions] };
      });
      return changed ? next : prev;
    }

    function tick() {
      setSavedPlans((prev) => {
        const afterFixed = frequencyEngine(prev);
        return levelCrossingEngine(afterFixed);
      });
    }
    const id = setInterval(tick, 60 * 1000);
    tick();
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!justSavedId) return;
    setExpandedPlanId(justSavedId);
    const t = setTimeout(() => setJustSavedId(null), 1800);
    return () => clearTimeout(t);
  }, [justSavedId]);

  useEffect(() => {
    if (!showLockInToast) return;
    const t = setTimeout(() => setShowLockInToast(false), 700);
    return () => clearTimeout(t);
  }, [showLockInToast]);

  useEffect(() => {
    window.history.scrollRestoration = "manual";
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    const el = riskSectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setRiskSectionVisible(true);
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = dashboardSectionRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setDashboardVisible(true);
      },
      { threshold: 0.1, rootMargin: "0px 0px -40px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const btcPriceAtRisk = getMockBtcPriceForRisk(simulatedRisk);
  const btcPrice = currency === "AUD" ? btcPriceAtRisk * USD_TO_AUD : btcPriceAtRisk;
  const symbol = currency === "AUD" ? "A$" : "$";
  const accumulateActive = simulatedRisk <= buyThreshold;
  const distributeActive = simulatedRisk >= sellThreshold;
  const strategyActive = dcaMode === "accumulate" ? accumulateActive : distributeActive;
  const intervalsPerYear = getIntervalsPerYear(frequency);
  const annualDeployed = dcaMode === "accumulate" && strategyActive ? Math.min(capital, investPerInterval * intervalsPerYear) : 0;
  const estimatedBtcAnnual = dcaMode === "accumulate" ? (btcPriceAtRisk > 0 ? annualDeployed / btcPriceAtRisk : 0) : 0;
  const remainingCapital = Math.max(0, capital - annualDeployed);
  const annualBtcSold = dcaMode === "distribute" && strategyActive ? Math.min(btcHoldings, (sellPerInterval / btcPriceAtRisk) * intervalsPerYear) : 0;
  const estimatedFiatFromDistribute = annualBtcSold * btcPriceAtRisk;
  const estimatedFiatDisplay = currency === "AUD" ? estimatedFiatFromDistribute * USD_TO_AUD : estimatedFiatFromDistribute;

  useEffect(() => {
    if (!riskSectionVisible) return;
    const prefersReducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      setDisplayValue(RISK_VALUE);
      setCountComplete(true);
      return;
    }
    const start = performance.now();
    let rafId: number;
    const tick = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / COUNT_DURATION_MS);
      const value = Math.floor(easeOutCubic(t) * RISK_VALUE);
      setDisplayValue(value);
      if (t < 1) {
        rafId = requestAnimationFrame(tick);
      } else {
        setDisplayValue(RISK_VALUE);
        setCountComplete(true);
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [riskSectionVisible]);

  const currentRiskForPlanner = RISK_VALUE;
  const btcPriceForPlanner = getMockBtcPriceForRisk(currentRiskForPlanner);
  const modeForCalc = dcaMode ?? "accumulate";
  const accumulateActivePlanner = currentRiskForPlanner <= buyThreshold;
  const distributeActivePlanner = currentRiskForPlanner >= sellThreshold;
  const strategyActivePlanner = modeForCalc === "accumulate" ? accumulateActivePlanner : distributeActivePlanner;
  const annualDeployedPlanner = modeForCalc === "accumulate" && strategyActivePlanner ? Math.min(capital, investPerInterval * intervalsPerYear) : 0;
  const estimatedBtcPlanner = btcPriceForPlanner > 0 ? annualDeployedPlanner / btcPriceForPlanner : 0;
  const remainingCapitalPlanner = Math.max(0, capital - annualDeployedPlanner);
  const annualBtcSoldPlanner = modeForCalc === "distribute" && strategyActivePlanner ? Math.min(btcHoldings, (sellPerInterval / btcPriceForPlanner) * intervalsPerYear) : 0;
  const estimatedFiatPlanner = annualBtcSoldPlanner * btcPriceForPlanner;
  const estimatedFiatPlannerDisplay = currency === "AUD" ? estimatedFiatPlanner * USD_TO_AUD : estimatedFiatPlanner;
  const dynamicPreviewSteps = [0, 1, 2].map((i) => {
    const risk = modeForCalc === "accumulate" ? buyThreshold - i * dynamicStepInterval : sellThreshold + i * dynamicStepInterval;
    const amt = modeForCalc === "accumulate"
      ? Math.round(investPerInterval * Math.pow(1 + dynamicMultiplierPct / 100, i))
      : Math.round(sellPerInterval * Math.pow(1 + dynamicMultiplierPct / 100, i));
    return { risk: Math.max(0, Math.min(100, risk)), amt };
  });
  const dynamicPreviewLines = dynamicPreviewSteps.map(({ risk, amt }) => `Risk ${risk} → ${symbol}${amt.toLocaleString()}`);
  const intervalsPerYearPlanner = getIntervalsPerYear(frequency);
  const capitalMode = "fixedSize" as "evenSplit" | "fixedSize"; // Define by Total Capital (evenSplit) vs Order Size (fixedSize)
  const effectiveInvestPerInterval = (modeForCalc === "accumulate" && strategyType === "fixed" && capitalMode === "evenSplit") && intervalsPerYearPlanner > 0
    ? Math.max(1, Math.floor(capital / intervalsPerYearPlanner))
    : investPerInterval;
  const amountPerTrigger = modeForCalc === "accumulate" ? effectiveInvestPerInterval : sellPerInterval;
  const triggersAvailable = amountPerTrigger > 0 ? Math.floor((modeForCalc === "accumulate" ? capital : (btcHoldings * btcPriceForPlanner)) / amountPerTrigger) : 0;
  const capitalDeployedIfAll = modeForCalc === "accumulate" ? Math.min(capital, amountPerTrigger * triggersAvailable) : 0;
  const remainingCapitalDisplay = modeForCalc === "accumulate" ? capital : (btcHoldings * btcPriceForPlanner);
  const capitalPctRemaining = capital > 0 ? 100 : 0;
  const estimatedDurationMonths = amountPerTrigger > 0 && modeForCalc === "accumulate" ? (triggersAvailable / (intervalsPerYearPlanner / 12)) : 0;
  const projectedBtc12Mo = btcPriceForPlanner > 0 && capital > 0 && modeForCalc === "accumulate" ? (investPerInterval * Math.min(triggersAvailable, intervalsPerYearPlanner)) / btcPriceForPlanner : 0;
  const timeToFullDeploymentMonths = strategyActivePlanner && amountPerTrigger > 0 ? capital / (investPerInterval * (intervalsPerYearPlanner / 12)) : 0;
  const dynamicDeploymentsRange = strategyType === "dynamic" && modeForCalc === "accumulate" ? { min: Math.max(0, Math.floor(triggersAvailable * 0.6)), max: Math.ceil(triggersAvailable * 1.2) } : null;

  const handleSaveStrategy = () => {
    if (!dcaMode || !strategyType) return;
    const name = strategyNameInput.trim() || "My strategy";
    const threshold = dcaMode === "accumulate" ? buyThreshold : sellThreshold;
    const amount = dcaMode === "accumulate" ? investPerInterval : sellPerInterval;
    const now = new Date().toISOString();
    const inZone = dcaMode === "accumulate"
      ? currentRiskForPlanner <= threshold
      : currentRiskForPlanner >= threshold;
    const isFixed = strategyType === "fixed";
    const isBuyFixed = dcaMode === "accumulate" && isFixed;
    const isSellFixed = dcaMode === "distribute" && isFixed;
    const initialExecutions: MockExecution[] = [];
    const freqMs = getFrequencyIntervalMs(frequency);
    const nextExecutionAt = inZone && isFixed ? new Date(Date.now() + freqMs).toISOString() : undefined;
    /** For scaled: persist full order plan so saved view does not recompute. */
    let computedOrders: { risk: number; amountFiat: number }[] | undefined;
    if (!isFixed) {
      const step = strategyType === "dynamic" ? dynamicStepInterval : 5;
      const mult = (strategyType === "dynamic" ? dynamicMultiplierPct : 25) / 100;
      const base = amount;
      if (dcaMode === "accumulate") {
        const levels: number[] = [];
        for (let r = threshold; r >= 0; r -= step) levels.push(r);
        computedOrders = levels.map((risk, i) => ({ risk, amountFiat: Math.round(base * Math.pow(1 + mult, i)) }));
      } else {
        const levels: number[] = [];
        for (let r = threshold; r <= 100; r += step) levels.push(r);
        computedOrders = levels.map((risk, i) => ({ risk, amountFiat: Math.round(base * Math.pow(1 + mult, i)) }));
      }
    }
    if (inZone && isBuyFixed) {
      const price = getMockBtcPriceForRisk(currentRiskForPlanner);
      const btcAmount = price > 0 ? amount / price : 0;
      initialExecutions.push({
        id: `exec-${Date.now()}`,
        date: now.slice(0, 10),
        riskAtExecution: currentRiskForPlanner,
        amountFiat: amount,
        btcAmount,
        pricePerBtc: price,
      });
    }
    if (inZone && isSellFixed) {
      const price = getMockBtcPriceForRisk(currentRiskForPlanner);
      const btcAmount = price > 0 ? amount / price : 0;
      initialExecutions.push({
        id: `exec-${Date.now()}`,
        date: now.slice(0, 10),
        riskAtExecution: currentRiskForPlanner,
        amountFiat: amount,
        btcAmount,
        pricePerBtc: price,
      });
    }
    const newPlan: SavedStrategy = {
      id: `plan-${Date.now()}`,
      name,
      mode: dcaMode,
      strategyType,
      type: strategyType === "fixed" ? "fixed" : "scaled",
      side: dcaMode === "accumulate" ? "buy" : "sell",
      triggerMode: strategyType === "fixed" ? "schedule" : "risk-step",
      threshold,
      frequency: isFixed ? frequency : undefined,
      amountPerPurchase: amount,
      capital: dcaMode === "accumulate" ? capital : 0,
      btcHoldings: dcaMode === "distribute" ? btcHoldings : undefined,
      alertsEnabled,
      active: inZone,
      createdAt: now.slice(0, 10),
      strategyStartDate: now,
      activatedAt: inZone ? now : undefined,
      lastExecutionAt: inZone && isFixed ? now : undefined,
      nextExecutionAt,
      status: inZone ? "Active" : "Waiting",
      dynamicStepInterval: (dcaMode === "distribute" && strategyType === "dynamic") ? dynamicStepInterval : undefined,
      dynamicMultiplierPct: strategyType === "dynamic" ? dynamicMultiplierPct : undefined,
      computedOrders,
      executions: initialExecutions,
    };
    setSavedPlans((prev) => [...prev, newPlan]);
    setStrategyNameInput("");
    setShowSaveStrategyModal(false);
    setJustSavedId(newPlan.id);
    setDashboardTab("savedPlan");
    setShowLockInToast(true);
  };

  const deletePlan = (id: string) => {
    setSavedPlans((prev) => prev.filter((p) => p.id !== id));
  };

  const loadPlanForEdit = (plan: SavedStrategy) => {
    setEditingPlanId(plan.id);
    setStrategyNameInput(plan.name);
    setDcaMode(plan.mode);
    setStrategyType(plan.strategyType ?? "fixed");
    setDynamicStepInterval(plan.dynamicStepInterval ?? 5);
    setDynamicMultiplierPct(plan.dynamicMultiplierPct ?? 25);
    if (plan.mode === "accumulate") {
      setBuyThreshold(plan.threshold);
      setCapital(plan.capital);
      setInvestPerInterval(plan.amountPerPurchase);
    } else {
      setSellThreshold(plan.threshold);
      setBtcHoldings(plan.btcHoldings ?? 0.5);
      setSellPerInterval(plan.amountPerPurchase);
    }
    setFrequency((plan.frequency ?? "weekly") as "daily" | "weekly" | "fortnightly" | "monthly");
    setAlertsEnabled(plan.alertsEnabled);
    setHasChosenMode(true);
    setHasChosenDcaType(true);
    setDashboardTab("manualPlanner");
  };

  const handleUpdateStrategy = () => {
    if (!editingPlanId || !dcaMode || !strategyType) return;
    const existing = savedPlans.find((p) => p.id === editingPlanId);
    if (!existing) return;
    const threshold = dcaMode === "accumulate" ? buyThreshold : sellThreshold;
    const amount = dcaMode === "accumulate" ? investPerInterval : sellPerInterval;
    const isFixed = strategyType === "fixed";
    let computedOrders: { risk: number; amountFiat: number }[] | undefined;
    if (!isFixed) {
      const step = strategyType === "dynamic" ? dynamicStepInterval : 5;
      const mult = (strategyType === "dynamic" ? dynamicMultiplierPct : 25) / 100;
      const base = amount;
      if (dcaMode === "accumulate") {
        const levels: number[] = [];
        for (let r = threshold; r >= 0; r -= step) levels.push(r);
        computedOrders = levels.map((risk, i) => ({ risk, amountFiat: Math.round(base * Math.pow(1 + mult, i)) }));
      } else {
        const levels: number[] = [];
        for (let r = threshold; r <= 100; r += step) levels.push(r);
        computedOrders = levels.map((risk, i) => ({ risk, amountFiat: Math.round(base * Math.pow(1 + mult, i)) }));
      }
    }
    const updated: SavedStrategy = {
      ...existing,
      name: strategyNameInput.trim() || existing.name,
      threshold,
      amountPerPurchase: amount,
      frequency: isFixed ? frequency : undefined,
      capital: dcaMode === "accumulate" ? capital : 0,
      btcHoldings: dcaMode === "distribute" ? btcHoldings : undefined,
      alertsEnabled,
      dynamicStepInterval: (dcaMode === "distribute" && strategyType === "dynamic") ? dynamicStepInterval : undefined,
      dynamicMultiplierPct: strategyType === "dynamic" ? dynamicMultiplierPct : undefined,
      computedOrders: isFixed ? existing.computedOrders : computedOrders,
      executions: existing.executions ?? [],
    };
    setSavedPlans((prev) => prev.map((p) => (p.id === editingPlanId ? updated : p)));
    setShowUpdateConfirmModal(false);
    setEditingPlanId(null);
    setStrategyNameInput("");
    setDashboardTab("savedPlan");
    setExpandedPlanId(editingPlanId);
  };

  const setPlanActive = (id: string, active: boolean) => {
    setSavedPlans((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p;
        if (active)
          return { ...p, active, activatedAt: p.activatedAt ?? new Date().toISOString(), nextExecutionAt: p.strategyType === "fixed" ? undefined : p.nextExecutionAt };
        return { ...p, active };
      })
    );
  };

  const setPlanAlerts = (id: string, alertsEnabled: boolean) => {
    setSavedPlans((prev) => prev.map((p) => (p.id === id ? { ...p, alertsEnabled } : p)));
  };

  function getPlanStatusDisplay(plan: SavedStrategy): string {
    const belowThreshold = RISK_VALUE <= plan.threshold;
    const aboveThreshold = RISK_VALUE >= plan.threshold;
    if (plan.mode === "accumulate") {
      if (belowThreshold) return plan.active ? "Active – Deploying" : "Triggered";
      return "Waiting";
    }
    if (aboveThreshold) return plan.active ? "Active – Deploying" : "Triggered";
    return "Waiting";
  }

  function getStatusTile(plan: SavedStrategy): "In range" | "Waiting" | "Triggered" | "Paused" {
    const inZone = plan.mode === "accumulate" ? RISK_VALUE <= plan.threshold : RISK_VALUE >= plan.threshold;
    if (!plan.active && inZone) return "Triggered"; // conditions met but plan off
    if (!plan.active) return "Paused";
    if (inZone) return "In range";
    return "Waiting";
  }

  function getNextCheckDays(freq: SavedStrategy["frequency"] | undefined): number {
    switch (freq) {
      case "daily": return 1;
      case "weekly": return 5;
      case "fortnightly": return 10;
      case "monthly": return 12;
      default: return 5;
    }
  }

  function getFrequencyLabel(freq: SavedStrategy["frequency"] | undefined): string {
    if (!freq) return "Event-based";
    return freq === "daily" ? "Daily" : freq === "weekly" ? "Weekly" : freq === "fortnightly" ? "Fortnightly" : "Monthly";
  }

  function getFrequencyIntervalMs(freq: SavedStrategy["frequency"]): number {
    switch (freq) {
      case "daily": return 24 * 60 * 60 * 1000;
      case "weekly": return 7 * 24 * 60 * 60 * 1000;
      case "fortnightly": return 14 * 24 * 60 * 60 * 1000;
      case "monthly": return 30 * 24 * 60 * 60 * 1000;
      default: return 7 * 24 * 60 * 60 * 1000;
    }
  }

  /** FIXED: from executions only. SCALED: from executions only (one execution per level; level-crossing engine adds them). */
  function getDisplayCompletedLevels(
    plan: SavedStrategy,
    levels: number[],
    executedByLevel: Map<number, MockExecution>
  ): Set<number> {
    return new Set(executedByLevel.keys());
  }

  function formatLastExecution(iso: string | undefined): string {
    if (!iso) return "—";
    const d = new Date(iso);
    const day = d.getDate();
    const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][d.getMonth()];
    const year = d.getFullYear();
    const h = d.getHours();
    const m = d.getMinutes();
    return `${day} ${mon} ${year}, ${h.toString().padStart(2,"0")}:${m.toString().padStart(2,"0")}`;
  }

  function formatNextExecutionCountdown(iso: string | undefined): string {
    if (!iso) return "—";
    const now = Date.now();
    const next = new Date(iso).getTime();
    const ms = Math.max(0, next - now);
    const d = Math.floor(ms / (24 * 60 * 60 * 1000));
    const h = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const m = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  /** Level-based view: accumulate = start down to end by interval; distribute = start up to end. */
  function getStrategyLevels(plan: SavedStrategy): number[] {
    const step = plan.dynamicStepInterval ?? 5;
    if (plan.mode === "accumulate") {
      const levels: number[] = [];
      for (let r = plan.threshold; r >= 0; r -= step) levels.push(r);
      return levels.length ? levels : [plan.threshold];
    }
    const levels: number[] = [];
    for (let r = plan.threshold; r <= 100; r += step) levels.push(r);
    return levels.length ? levels : [plan.threshold];
  }

  /** Levels for display: from persisted computedOrders when present (scaled), else computed. */
  function getDisplayLevels(plan: SavedStrategy): number[] {
    if (plan.type === "scaled" && plan.computedOrders?.length) return plan.computedOrders.map((o) => o.risk);
    return getStrategyLevels(plan);
  }

  /** Order size at risk level: from computedOrders when present, else recomputed. */
  function getAmountAtRiskFromPlan(plan: SavedStrategy, risk: number): number {
    if (plan.type === "scaled" && plan.computedOrders?.length) {
      const order = plan.computedOrders.find((o) => o.risk === risk);
      if (order != null) return order.amountFiat;
    }
    return getAmountAtRisk(plan, risk);
  }

  function getAmountAtRisk(plan: SavedStrategy, risk: number): number {
    if (plan.mode === "accumulate") {
      if (plan.strategyType === "dynamic" && plan.dynamicStepInterval != null && plan.dynamicMultiplierPct != null) {
        const steps = Math.max(0, Math.floor((plan.threshold - risk) / plan.dynamicStepInterval));
        return Math.round(plan.amountPerPurchase * Math.pow(1 + plan.dynamicMultiplierPct / 100, steps));
      }
      return plan.amountPerPurchase;
    }
    if (plan.strategyType === "dynamic" && plan.dynamicStepInterval != null && plan.dynamicMultiplierPct != null) {
      const steps = Math.max(0, Math.floor((risk - plan.threshold) / plan.dynamicStepInterval));
      return Math.round(plan.amountPerPurchase * Math.pow(1 + plan.dynamicMultiplierPct / 100, steps));
    }
    return plan.amountPerPurchase;
  }

  function getDynamicTierBands(plan: SavedStrategy): { risk: number; amount: number }[] {
    const step = plan.dynamicStepInterval ?? 5;
    const mult = (plan.dynamicMultiplierPct ?? 25) / 100;
    const base = plan.amountPerPurchase;
    if (plan.mode === "accumulate") {
      return [0, 1, 2, 3].map((i) => {
        const risk = Math.max(0, plan.threshold - i * step);
        const amount = Math.round(base * Math.pow(1 + mult, i));
        return { risk, amount };
      });
    }
    return [0, 1, 2, 3].map((i) => {
      const risk = Math.min(100, plan.threshold + i * step);
      const amount = Math.round(base * Math.pow(1 + mult, i));
      return { risk, amount };
    });
  }

  function ScalingRuleBlock({
    side,
    startingLevel,
    interval,
    increasePct,
    onIntervalChange,
    onIncreasePctChange,
  }: {
    side: "buy" | "sell";
    startingLevel: number;
    interval: number;
    increasePct: number;
    onIntervalChange: (v: number) => void;
    onIncreasePctChange: (v: number) => void;
  }) {
    return (
      <div className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3">
        <p className="text-[11px] font-medium uppercase tracking-wider text-white/60 mb-2">Scaling Rule</p>
        <p className="mb-3 text-[11px] text-white/70">
          When risk moves every {interval} points from starting level <span style={{ color: getRiskColor(startingLevel) }}>{startingLevel}</span>, adjust order size by {increasePct}%.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-white/60">Risk Interval</label>
            <input type="number" min={1} max={20} value={interval} onChange={(e) => onIntervalChange(Number(e.target.value) || 5)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-white/60">Increase per level (%)</label>
            <input type="number" min={0} max={100} value={increasePct} onChange={(e) => onIncreasePctChange(Number(e.target.value) || 25)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" />
          </div>
        </div>
      </div>
    );
  }

  function NextActionCard({
    header,
    primaryLine,
    secondaryLine,
    alerts,
    elevated = true,
  }: {
    header: string;
    primaryLine: React.ReactNode;
    secondaryLine?: React.ReactNode;
    alerts: React.ReactNode;
    elevated?: boolean;
  }) {
    return (
      <div
        className={`next-action-card relative rounded-xl border pl-[11px] pr-5 py-4 flex flex-wrap items-center justify-between gap-4 transition-all duration-[180ms] ease-out
          ${elevated
            ? "next-action-card-elevated border-[#f59e0b]/25 bg-gradient-to-br from-white/[0.14] to-white/[0.06] shadow-[0_2px_12px_-2px_rgba(0,0,0,0.2),0_0_0_1px_rgba(255,255,255,0.04)] hover:-translate-y-0.5 hover:border-[#f59e0b]/40 hover:shadow-[0_4px_16px_-2px_rgba(0,0,0,0.25),0_0_0_1px_rgba(245,158,11,0.12)]"
            : "bg-white/[0.08] border-white/15 hover:border-white/20"
          }`}
      >
        {/* 3px vertical accent bar — neutral, consistent for buy/sell */}
        <div className="absolute left-0 top-3 bottom-3 w-[3px] rounded-r bg-white/35" aria-hidden />
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-white/55">{header}</p>
          <p className="text-2xl font-bold text-white tabular-nums leading-tight tracking-tight">{primaryLine}</p>
          {secondaryLine != null && <p className="text-sm text-white/75 tabular-nums mt-0.5">{secondaryLine}</p>}
        </div>
        <div className="flex items-center gap-2 shrink-0 self-center">
          {alerts}
        </div>
      </div>
    );
  }

  const handleSliderRelease = () => {
    const startVal = simulatedRisk;
    if (startVal === RISK_VALUE) return;
    const start = performance.now();
    const dur = 250;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setSimulatedRisk(Math.round(startVal + (RISK_VALUE - startVal) * eased));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  return (
    <>
      {showLockInToast && (
        <div className="fixed bottom-8 left-1/2 z-[60] -translate-x-1/2 rounded-lg border border-white/20 bg-[#0a1f35] px-5 py-3 shadow-lg ring-1 ring-[#F28C28]/30" role="status" aria-live="polite">
          <p className="text-sm font-medium text-white">Strategy saved.</p>
        </div>
      )}
      {showSaveStrategyModal && dcaMode && strategyType && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm transition-opacity duration-200" role="dialog" aria-modal="true" aria-labelledby="save-strategy-title">
          <div className="w-full max-w-sm rounded-xl border border-white/15 bg-[#0a1f35] p-6 shadow-2xl">
            <h3 id="save-strategy-title" className="text-sm font-semibold text-white">Name Your Strategy</h3>
            <input type="text" value={strategyNameInput} onChange={(e) => setStrategyNameInput(e.target.value)} placeholder="e.g. Accumulation 30–0" className="mt-4 w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/40 focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" aria-label="Strategy name" />
            <div className="mt-6 flex gap-2">
              <button type="button" onClick={() => { setShowSaveStrategyModal(false); setStrategyNameInput(""); }} className="flex-1 rounded-lg border border-white/20 py-2 text-sm font-medium text-white/90 hover:bg-white/5" disabled={lockingIn}>Cancel</button>
              <button type="button" onClick={() => { setLockingIn(true); setTimeout(() => { handleSaveStrategy(); setLockingIn(false); }, 400); }} className={`flex-1 rounded-lg py-2 text-sm font-medium text-white transition-all duration-200 ${lockingIn ? "bg-[#F28C28] scale-[1.01]" : "bg-[#F28C28] hover:bg-[#d97a22]"}`} disabled={lockingIn}>
                {lockingIn ? "Saving…" : "Confirm Strategy"}
              </button>
            </div>
          </div>
        </div>
      )}
      {showUpdateConfirmModal && editingPlanId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="update-strategy-title">
          <div className="w-full max-w-sm rounded-xl border border-white/15 bg-[#0a1f35] p-6 shadow-2xl">
            <h3 id="update-strategy-title" className="text-sm font-semibold text-white">Update strategy?</h3>
            <p className="mt-3 text-sm text-white/80">This will update your active strategy.</p>
            <ul className="mt-2 list-inside list-disc space-y-1 text-[13px] text-white/70">
              <li>Execution history will remain intact.</li>
              <li>Updated rules apply from this point forward.</li>
            </ul>
            <div className="mt-6 flex gap-2">
              <button type="button" onClick={() => setShowUpdateConfirmModal(false)} className="flex-1 rounded-lg border border-white/20 py-2 text-sm font-medium text-white/90 hover:bg-white/5">Cancel</button>
              <button type="button" onClick={handleUpdateStrategy} className="flex-1 rounded-lg bg-[#F28C28] py-2 text-sm font-medium text-white hover:bg-[#d97a22] focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#0a1f35]">Confirm changes</button>
            </div>
          </div>
        </div>
      )}
      <style
        dangerouslySetInnerHTML={{
          __html: `
            html { scroll-behavior: smooth; }
            @media (prefers-reduced-motion: reduce) {
              html { scroll-behavior: auto; }
            }
            @keyframes heroEnter {
              from { opacity: 0; transform: translateY(10px); }
              to { opacity: 1; transform: translateY(0); }
            }
            .hero-item {
              opacity: 0;
              animation: heroEnter 0.4s ease-out forwards;
            }
            @media (prefers-reduced-motion: reduce) {
              .hero-item {
                animation: none;
                opacity: 1;
                transform: none;
              }
            }
            @keyframes ambientShift {
              0%, 100% { background-position: 50% 40%; }
              50% { background-position: 50% 48%; }
            }
            .hero-ambient {
              animation: ambientShift 20s ease-in-out infinite;
            }
            @media (prefers-reduced-motion: reduce) {
              .hero-ambient {
                animation: none;
              }
            }
            .risk-section-inview {
              opacity: 1;
              transform: translateY(0);
            }
            @media (prefers-reduced-motion: reduce) {
              #current-btc-risk > div {
                opacity: 1;
                transform: none;
              }
            }
            @keyframes riskGlowPulse {
              0%, 100% { opacity: 0.12; transform: translate(-50%, -50%) scale(1); }
              50% { opacity: 0.28; transform: translate(-50%, -50%) scale(1.08); }
            }
            .risk-glow-pulse {
              animation: riskGlowPulse 0.7s ease-out forwards;
            }
            @media (prefers-reduced-motion: reduce) {
              .risk-glow-pulse {
                animation: none;
                opacity: 0.12;
                transform: translate(-50%, -50%) scale(1);
              }
            }
            @media (prefers-reduced-motion: reduce) {
              #btc-dashboard > div {
                opacity: 1;
                transform: none;
              }
            }
            .risk-slider {
              -webkit-appearance: none;
              appearance: none;
              background: transparent;
            }
            .risk-slider::-webkit-slider-thumb {
              -webkit-appearance: none;
              appearance: none;
              width: 18px;
              height: 18px;
              border-radius: 50%;
              border: 2px solid rgba(255,255,255,0.9);
              cursor: pointer;
              box-shadow: 0 1px 3px rgba(0,0,0,0.3);
              transition: transform 0.15s ease;
            }
            .risk-slider::-webkit-slider-thumb:hover {
              transform: scale(1.05);
            }
            .risk-slider::-moz-range-thumb {
              width: 18px;
              height: 18px;
              border-radius: 50%;
              border: 2px solid rgba(255,255,255,0.9);
              cursor: pointer;
              box-shadow: 0 1px 3px rgba(0,0,0,0.3);
              background: transparent;
            }
            .risk-slider::-webkit-slider-runnable-track {
              height: 8px;
              border-radius: 4px;
            }
            .risk-slider::-moz-range-track {
              height: 8px;
              border-radius: 4px;
            }
            .risk-slider-thumb {
              box-shadow: 0 0 0 2px rgba(0,0,0,0.25), 0 2px 8px rgba(0,0,0,0.5), 0 0 12px rgba(255,255,255,0.15);
            }
            .strategy-summary-card {
              animation: strategyCardEnter 0.4s ease-out;
            }
            @keyframes strategyCardEnter {
              from { opacity: 0.97; }
              to { opacity: 1; }
            }
            @media (prefers-reduced-motion: reduce) {
              .strategy-summary-card { animation: none; }
            }
            .input-first:focus {
              box-shadow: 0 0 0 1px rgba(242,140,40,0.25), 0 0 16px rgba(242,140,40,0.12);
            }
            .risk-number-glow {
              text-shadow: 0 0 18px var(--risk-glow);
              transition: text-shadow 200ms ease-in-out;
            }
            .risk-number-glow.risk-number-glow-hover {
              text-shadow: 0 0 26px var(--risk-glow);
              animation: riskGlowPulse 2.2s ease-in-out infinite;
            }
            @keyframes riskGlowPulse {
              0%, 100% { text-shadow: 0 0 26px var(--risk-glow); }
              50% { text-shadow: 0 0 32px var(--risk-glow); }
            }
            @media (prefers-reduced-motion: reduce) {
              .risk-number-glow.risk-number-glow-hover { animation: none; }
            }
            .saved-card-enter {
              animation: savedCardEnter 0.5s ease-out forwards;
            }
            @keyframes savedCardEnter {
              from { opacity: 0; transform: scale(0.97); }
              to { opacity: 1; transform: scale(1); }
            }
            .saved-card-enter .saved-card-badge { animation: badgeFadeIn 0.4s ease-out 0.2s forwards; opacity: 0; }
            @keyframes badgeFadeIn { to { opacity: 1; } }
            .saved-card-highlight {
              animation: savedCardHighlight 1.5s ease-out forwards;
            }
            @keyframes savedCardHighlight {
              0% { box-shadow: 0 0 0 0 rgba(242,140,40,0.15); }
              30% { box-shadow: 0 0 20px 2px rgba(242,140,40,0.12); }
              100% { box-shadow: none; }
            }
            @media (prefers-reduced-motion: reduce) {
              .saved-card-highlight { animation: none; }
            }
            .next-action-card-elevated {
              animation: nextActionFadeIn 350ms ease-out;
            }
            @keyframes nextActionFadeIn {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            @media (prefers-reduced-motion: reduce) {
              .next-action-card-elevated { animation: none; }
              .next-action-card.hover\:-translate-y-0\.5:hover { transform: none; }
            }
            .risk-marker-pending {
              background: transparent;
              border: 1px solid rgba(255,255,255,0.35);
            }
            .risk-marker-future {
              background: transparent;
              border: 1px solid rgba(255,255,255,0.18);
            }
            .risk-marker-completed {
              border: 1.5px solid rgba(255,255,255,0.5);
              background: rgba(255,255,255,0.45);
              transform: translate(-50%, -50%) scale(1.1);
            }
            .risk-marker-completed .risk-marker-tick {
              color: rgba(255,255,255,0.95);
            }
            .risk-marker-next {
              background: rgba(255,255,255,0.12);
              border: 1px solid rgba(255,255,255,0.4);
              animation: riskMarkerPulseSoft 2s ease-in-out infinite;
            }
            @keyframes riskMarkerPulseSoft {
              0%, 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0.15); }
              50% { box-shadow: 0 0 0 4px rgba(255,255,255,0.06); }
            }
            @media (prefers-reduced-motion: reduce) {
              .risk-marker-next { animation: none; }
            }
            .segmented-btn:focus, .segmented-btn:focus-visible,
            button[role="switch"]:focus, button[role="switch"]:focus-visible,
            #btc-dashboard button[aria-pressed]:focus, #btc-dashboard button[aria-pressed]:focus-visible {
              outline: none;
              box-shadow: none;
            }
            .risk-band-table { table-layout: fixed; width: 100%; }
            .risk-band-table th, .risk-band-table td { width: 50%; text-align: center; }
            .breakdown-scroll { scrollbar-width: thin; }
            .breakdown-scroll::-webkit-scrollbar { width: 6px; }
            .breakdown-scroll::-webkit-scrollbar-track { background: rgba(255,255,255,0.04); border-radius: 3px; }
            .breakdown-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 3px; }
            .strategy-help-icon { font-size: 14px; opacity: 0.7; cursor: pointer; transition: opacity 0.15s ease; }
            .strategy-help-icon:hover { opacity: 1; }
            .strategy-help-tooltip-portal {
              max-width: min(280px, calc(100vw - 2rem));
              width: max-content;
              padding: 0.75rem 0.875rem;
              background: #081625;
              border: 1px solid rgba(255,255,255,0.12);
              border-radius: 12px;
              box-shadow: 0 10px 30px rgba(0,0,0,0.3);
              white-space: normal;
              word-wrap: break-word;
            }
            .strategy-help-tooltip-portal * { white-space: normal; word-wrap: break-word; }
            .strategy-help-tooltip-inner {
              opacity: 0;
              transform: translateY(6px);
              animation: strategyHelpFadeSlide 0.15s ease forwards;
            }
            @keyframes strategyHelpFadeSlide {
              from { opacity: 0; transform: translateY(6px); }
              to { opacity: 1; transform: translateY(0); }
            }
          `,
        }}
      />
      <div
        className="min-h-screen w-full relative"
        style={{
          background: "radial-gradient(ellipse 100% 100% at 50% 50%, #102a43 0%, #0b1f33 55%, #081625 100%)",
        }}
      >
        <div className="pointer-events-none fixed inset-0 z-[1] opacity-[0.015]" style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")", backgroundRepeat: "repeat" }} aria-hidden />
        <div className="relative z-10 min-h-screen w-full">
        <div
          className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-6"
        >
          <div className="hero-ambient pointer-events-none absolute inset-0" style={{ background: "radial-gradient(ellipse 100% 80% at 50% 38%, rgba(255,255,255,0.06) 0%, transparent 55%)" }} aria-hidden />
          <main className="relative z-10 max-w-2xl text-center">
            <div
              className="hero-item relative mx-auto mb-4 w-fit transition-transform duration-300 ease-out hover:scale-[1.02] motion-reduce:hover:scale-100"
              style={{ animationDelay: "0ms" }}
            >
              <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(ellipse 90% 70% at 50% 45%, rgba(255,255,255,0.04) 0%, transparent 60%)" }} aria-hidden />
              <img
                src="/brand/csh-mark-inverse.svg"
                alt="Crypto Super Hub"
                className="relative z-10 block h-24 w-auto md:h-28"
              />
            </div>
            <p className="hero-item text-xs font-semibold uppercase tracking-[0.2em] text-[#F28C28]" style={{ animationDelay: "50ms" }}>
              Crypto Super Hub
            </p>
            <h1
              className="hero-item mt-4 text-4xl font-bold leading-tight text-white md:text-5xl lg:text-6xl tracking-tight"
              style={{ animationDelay: "100ms" }}
            >
              Markets rise. Markets fall.
            </h1>
            <p
              className="hero-item mt-3 mx-auto max-w-sm text-lg md:text-xl leading-snug text-white/90"
              style={{ animationDelay: "150ms" }}
            >
              Decide what to do before they do.
            </p>
            <p
              className="hero-item mt-6 mx-auto max-w-md text-sm text-white/65"
              style={{ animationDelay: "200ms" }}
            >
              A structured framework for digital asset investing.
            </p>
            <div
              className="hero-item mx-auto my-6 h-px w-16 bg-[#F28C28]/80"
              aria-hidden
              style={{ animationDelay: "250ms" }}
            />
            <div className="hero-item flex flex-col sm:flex-row items-center justify-center gap-3 mt-6" style={{ animationDelay: "300ms" }}>
              <a
                href="#btc-dashboard"
                onClick={() => setAccessLevel("trial")}
                className="w-full sm:w-auto inline-block rounded-lg bg-[#F28C28] px-6 py-3 text-center text-sm font-medium text-white shadow-sm transition-all duration-200 ease-out hover:-translate-y-0.5 hover:bg-[#d97a22] hover:shadow-md focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#0E2A47]"
              >
                Start Free 7-Day Trial
              </a>
              <a
                href="#btc-dashboard"
                className="w-full sm:w-auto inline-block rounded-lg border border-white/25 px-6 py-3 text-center text-sm font-medium text-white/90 transition-all duration-200 ease-out hover:border-white/40 hover:bg-white/5 hover:text-white focus:outline-none focus:ring-2 focus:ring-white/20 focus:ring-offset-2 focus:ring-offset-[#0E2A47]"
              >
                Explore the Framework
              </a>
            </div>
          </main>
        </div>

      <section
        id="current-btc-risk"
        ref={riskSectionRef}
        className="relative z-10 min-h-[60vh] px-6 pt-28 pb-24 md:pt-36 md:pb-32"
      >
        <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(ellipse 100% 75% at 50% 44%, rgba(255,255,255,0.05) 0%, transparent 55%)" }} aria-hidden />
        <div
          className={`relative mx-auto max-w-2xl text-center transition-all duration-700 ease-out ${
            riskSectionVisible ? "risk-section-inview" : "opacity-0 translate-y-8"
          }`}
        >
          <p className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-white/65">
            CURRENT BTC RISK
          </p>
          <p
            className={`relative z-10 mx-auto mb-8 w-fit cursor-default text-6xl font-bold tabular-nums md:text-7xl transition-colors duration-200 risk-number-glow ${riskNumberHover ? "risk-number-glow-hover" : ""}`}
            style={{
              color: getRiskColor(displayValue),
              ["--risk-glow" as string]: riskNumberHover ? "rgba(255,240,245,0.32)" : "rgba(255,240,245,0.22)",
            }}
            onMouseEnter={() => setRiskNumberHover(true)}
            onMouseLeave={() => setRiskNumberHover(false)}
            aria-label={`Risk level ${RISK_VALUE}`}
          >
            {displayValue}
          </p>
          <p className="mx-auto mb-8 text-xs tracking-wide text-white/55">
            0 (Low) → 100 (Extreme)
          </p>
          <p className="mx-auto mb-10 max-w-md text-sm leading-relaxed text-white/65">
            Long-term regression of Bitcoin price data measures relative market risk. Lower values historically reflect earlier cycle positioning. Higher values reflect later cycle positioning.
          </p>
          <a
            href="#btc-dashboard"
            className="inline-block rounded-lg border border-white/30 bg-transparent px-6 py-3 text-center text-sm font-medium text-white/90 transition-all duration-200 ease-out hover:border-[#F28C28] hover:bg-white/5 hover:text-white focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#061826]"
          >
            Explore the Dashboard
          </a>
        </div>
      </section>

      <section
        id="btc-dashboard"
        ref={dashboardSectionRef}
        className="relative z-10 min-h-[60vh] px-6 pt-24 pb-28 md:pt-32 md:pb-36"
      >
        <div className="pointer-events-none absolute inset-0 opacity-100" style={{ background: "radial-gradient(ellipse 110% 75% at 50% 50%, rgba(255,255,255,0.06) 0%, transparent 55%)" }} aria-hidden />
        <div
          className={`relative mx-auto max-w-3xl transition-all duration-700 ease-out ${
            dashboardVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
          }`}
        >
          <div className="absolute -inset-6 rounded-2xl opacity-60 blur-xl" style={{ background: "radial-gradient(ellipse 80% 50% at 50% 40%, rgba(255,255,255,0.06) 0%, transparent 70%)" }} aria-hidden />
          <div className="relative rounded-xl border border-white/15 bg-white/[0.09] shadow-2xl shadow-black/25 backdrop-blur-sm ring-1 ring-white/10" style={{ boxShadow: "0 0 0 1px rgba(255,255,255,0.08) inset, 0 25px 50px -12px rgba(0,0,0,0.3)" }}>
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4 md:px-8 md:py-5">
              <h2 className="text-lg font-semibold text-white md:text-xl">
                BTC Dashboard
              </h2>
              <div className="flex rounded-lg border border-white/15 bg-white/5 p-0.5">
                <button
                  type="button"
                  onClick={() => setCurrency("USD")}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    currency === "USD" ? "bg-[#F28C28] text-white" : "text-white/70 hover:text-white"
                  }`}
                  aria-pressed={currency === "USD"}
                >
                  USD
                </button>
                <button
                  type="button"
                  onClick={() => setCurrency("AUD")}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    currency === "AUD" ? "bg-[#F28C28] text-white" : "text-white/70 hover:text-white"
                  }`}
                  aria-pressed={currency === "AUD"}
                >
                  AUD
                </button>
              </div>
            </div>

            <div className="flex border-b border-white/10 p-1">
              {[
                { id: "riskIndex" as const, label: "Risk Index" },
                { id: "manualPlanner" as const, label: "Strategy Builder" },
                { id: "savedPlan" as const, label: "My Strategies" },
                { id: "backtest" as const, label: "Simulator (Pro)", locked: !canAccessSimulatorPro },
              ].map(({ id, label, locked }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => locked && id === "backtest" ? setDashboardTab("backtest") : setDashboardTab(id)}
                  className={`flex flex-1 items-center justify-center gap-1 rounded-md py-2.5 text-xs font-medium transition-colors ${
                    dashboardTab === id ? "bg-white/10 text-white" : "text-white/60 hover:text-white"
                  } ${locked && id === "backtest" ? "opacity-80" : ""}`}
                  aria-pressed={dashboardTab === id}
                  title={locked && id === "backtest" ? "Start free trial to unlock" : undefined}
                >
                  {label}
                  {locked && id === "backtest" && <span className="text-[10px] text-white/40" aria-hidden>🔒</span>}
                </button>
              ))}
            </div>

            {/* Risk Index tab — daily check */}
            {dashboardTab === "riskIndex" && (
              <div className="px-6 py-5 md:px-8 md:py-6">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 border-b border-white/10 pb-5">
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wider text-white/50">BTC Price</p>
                    <p className="mt-1.5 text-lg font-bold tabular-nums text-white md:text-xl">
                      {symbol}{Math.round(btcPrice).toLocaleString()}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wider text-white/50">24h Change</p>
                    <p className={`mt-1.5 text-lg font-bold tabular-nums md:text-xl ${MOCK_BTC_24H_CHANGE >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {MOCK_BTC_24H_CHANGE >= 0 ? "+" : ""}{MOCK_BTC_24H_CHANGE}%
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wider text-white/50">Current BTC Risk</p>
                    <p className="mt-1.5 text-lg font-bold tabular-nums md:text-xl" style={{ color: getRiskColor(simulatedRisk) }}>
                      {simulatedRisk}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wider text-white/50">Last Updated</p>
                    <p className="mt-1.5 text-lg font-bold tabular-nums text-white md:text-xl">{MOCK_LAST_UPDATED}</p>
                  </div>
                </div>
                <div className="mt-5">
                  <div className="flex justify-between text-xs text-white/50">
                    <span>0</span><span>Risk</span><span>100</span>
                  </div>
                  <div
                    className="relative mt-2 h-2 w-full overflow-hidden rounded-full"
                    style={{ background: `linear-gradient(to right, ${getRiskColor(0)} 0%, ${getRiskColor(50)} 50%, ${getRiskColor(100)} 100%)` }}
                  >
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={simulatedRisk}
                      onChange={(e) => setSimulatedRisk(Number(e.target.value))}
                      onPointerUp={handleSliderRelease}
                      onMouseUp={handleSliderRelease}
                      className="risk-slider absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      aria-label="Risk level (exploratory; resets to current)"
                    />
                    <div
                      className="risk-slider-thumb pointer-events-none absolute top-1/2 z-10 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white transition-[left] duration-150"
                      style={{ left: `${simulatedRisk}%`, backgroundColor: getRiskColor(simulatedRisk) }}
                      aria-hidden
                    />
                  </div>
                  <p className="mt-2 text-[10px] text-white/50">Drag to explore; releases to current risk.</p>
                </div>
                <p className="mt-5 text-xs leading-relaxed text-white/70">
                  Long-term regression of Bitcoin price data measures relative market risk. Lower values historically reflect earlier cycle positioning. Higher values reflect later cycle positioning.
                </p>
                <div className="mt-5 border-t border-white/10 pt-5">
                  <button
                    type="button"
                    onClick={() => setRiskBandOpen((o) => !o)}
                    className="flex w-full cursor-pointer items-center justify-between rounded-lg px-2 py-2.5 text-left text-xs font-medium text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white focus:outline-none focus-visible:ring-0"
                    aria-expanded={riskBandOpen}
                  >
                    <span>View Full BTC Risk Band</span>
                    <span className="shrink-0 transition-transform duration-200" style={{ transform: riskBandOpen ? "rotate(180deg)" : "none" }}>▼</span>
                  </button>
                  {riskBandOpen && (
                    <div
                      ref={riskBandContainerRef}
                      className="mt-3 max-h-[18rem] overflow-auto rounded-xl border border-white/15 bg-[#081826]/95 shadow-inner"
                      onScroll={(e) => setRiskBandScrollTop(e.currentTarget.scrollTop)}
                      style={{ minHeight: "12rem" }}
                    >
                      <table className="risk-band-table w-full text-sm border-collapse" style={{ tableLayout: "fixed" }}>
                        <thead className="sticky top-0 z-10 border-b border-white/15 bg-[#081826] text-xs uppercase tracking-wider text-white/80 shadow-[0_1px_0_0_rgba(255,255,255,0.08)]">
                          <tr>
                            <th className="px-4 py-3 font-medium w-1/2 text-center">Risk</th>
                            <th className="px-4 py-3 font-medium w-1/2 text-center">BTC Price</th>
                          </tr>
                        </thead>
                        <tbody style={{ height: RISK_BAND_VALUES.length * RISK_BAND_ROW_HEIGHT }}>
                          {(() => {
                            const containerHeight = riskBandContainerRef.current?.clientHeight ?? 288;
                            const visibleCount = Math.ceil(containerHeight / RISK_BAND_ROW_HEIGHT) + RISK_BAND_VISIBLE_EXTRA * 2;
                            const visibleStart = Math.max(0, Math.floor(riskBandScrollTop / RISK_BAND_ROW_HEIGHT) - RISK_BAND_VISIBLE_EXTRA);
                            const visibleEnd = Math.min(RISK_BAND_VALUES.length - 1, visibleStart + visibleCount - 1);
                            const topHeight = visibleStart * RISK_BAND_ROW_HEIGHT;
                            const bottomHeight = (RISK_BAND_VALUES.length - 1 - visibleEnd) * RISK_BAND_ROW_HEIGHT;
                            return (
                              <>
                                {topHeight > 0 && (
                                  <tr aria-hidden><td colSpan={2} style={{ height: topHeight, padding: 0, border: 0, lineHeight: 0 }} /></tr>
                                )}
                                {RISK_BAND_VALUES.slice(visibleStart, visibleEnd + 1).map((r) => {
                                  const isCurrent = Math.abs(simulatedRisk - r) <= 2.5; // highlight closest row for step-5 band
                                  return (
                                    <tr
                                      key={r}
                                      className={`border-b border-white/5 ${isCurrent ? "ring-inset ring-1 ring-white/25" : ""}`}
                                      style={{ backgroundColor: getRiskBgRgba(r, 0.2), height: RISK_BAND_ROW_HEIGHT }}
                                    >
                                      <td className="risk-band-cell px-4 py-0 tabular-nums font-medium text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.4)] align-middle text-center" style={{ color: getRiskColor(r), height: RISK_BAND_ROW_HEIGHT }}>{formatRiskValue(r)}</td>
                                      <td className="risk-band-cell px-4 py-0 tabular-nums text-white/95 drop-shadow-[0_1px_1px_rgba(0,0,0,0.4)] align-middle text-center" style={{ height: RISK_BAND_ROW_HEIGHT }}>
                                        {symbol}{Math.round((currency === "AUD" ? getMockBtcPriceForRisk(r) * USD_TO_AUD : getMockBtcPriceForRisk(r))).toLocaleString()}
                                      </td>
                                    </tr>
                                  );
                                })}
                                {bottomHeight > 0 && (
                                  <tr aria-hidden><td colSpan={2} style={{ height: bottomHeight, padding: 0, border: 0, lineHeight: 0 }} /></tr>
                                )}
                              </>
                            );
                          })()}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Strategy Builder tab — unified structure for Fixed and Scaled */}
            {dashboardTab === "manualPlanner" && (
              <div className="px-6 py-5 md:px-8 md:py-6">
                {editingPlanId && (() => {
                  const editingPlan = savedPlans.find((p) => p.id === editingPlanId);
                  return editingPlan ? (
                    <div className="mb-4 rounded-lg border border-white/15 bg-white/[0.06] px-4 py-2.5 flex items-center justify-between gap-3">
                      <p className="text-sm text-white/90">Editing: <span className="font-medium text-white">{editingPlan.name}</span></p>
                    </div>
                  ) : null;
                })()}
                <p className="mb-3 text-sm text-white/80">Choose mode</p>
                <div className="flex rounded-lg border border-white/10 bg-white/[0.06] p-0.5 gap-0.5">
                  <button
                    type="button"
                    onClick={() => { setDcaMode("accumulate"); setHasChosenMode(true); }}
                    className={`segmented-btn flex-1 rounded-md py-2.5 text-xs font-medium transition-all duration-150 border border-white/10 focus:outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 ${dcaMode === "accumulate" ? "bg-white/12 text-white" : "bg-transparent text-white/60 hover:text-white hover:bg-white/[0.08]"}`}
                    aria-pressed={dcaMode === "accumulate"}
                  >
                    Accumulate (Buy)
                  </button>
                  <button
                    type="button"
                    onClick={() => { setDcaMode("distribute"); setHasChosenMode(true); }}
                    className={`segmented-btn flex-1 rounded-md py-2.5 text-xs font-medium transition-all duration-150 border border-white/10 focus:outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 ${dcaMode === "distribute" ? "bg-white/12 text-white" : "bg-transparent text-white/60 hover:text-white hover:bg-white/[0.08]"}`}
                    aria-pressed={dcaMode === "distribute"}
                  >
                    Distribute (Sell)
                  </button>
                </div>

                <div className={`overflow-hidden transition-all duration-300 ease-out ${hasChosenMode ? "max-h-80 opacity-100 mt-6" : "max-h-0 opacity-0"}`}>
                  <div ref={strategyHelpAreaRef}>
                    <p className="mb-3 text-sm text-white/80">Strategy type</p>
                    <div className="mb-6 flex rounded-lg border border-white/10 bg-white/[0.06] p-0.5 gap-0.5">
                      <button
                        type="button"
                        onClick={() => { setHasChosenDcaType(true); setStrategyType("fixed"); }}
                        className={`segmented-btn flex-1 rounded-md py-2 text-xs font-medium transition-all duration-150 border border-white/10 focus:outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 flex items-center justify-center gap-1.5 relative ${strategyType === "fixed" ? "bg-white/12 text-white" : "bg-transparent text-white/60 hover:text-white hover:bg-white/[0.08]"}`}
                        aria-pressed={strategyType === "fixed"}
                      >
                        <span>Fixed Strategy</span>
                        <span
                          ref={fixedHelpIconRef}
                          className="strategy-help-icon inline-flex items-center justify-center text-white/70 hover:text-white/90 shrink-0 w-4 h-4"
                          role="button"
                          tabIndex={0}
                          aria-label="What is Fixed Strategy?"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setStrategyHelpOpen((s) => (s === "fixed" ? null : "fixed")); }}
                          onMouseEnter={() => setStrategyHelpOpen("fixed")}
                          onMouseLeave={(e) => { const to = (e.nativeEvent as MouseEvent).relatedTarget as Node | null; if (to && strategyTooltipRef.current?.contains(to)) return; setStrategyHelpOpen((s) => (s === "fixed" ? null : s)); }}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setStrategyHelpOpen((s) => (s === "fixed" ? null : "fixed")); } }}
                        >
                          ⓘ
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => { setHasChosenDcaType(true); setStrategyType("dynamic"); }}
                        className={`segmented-btn flex-1 rounded-md py-2 text-xs font-medium transition-all duration-150 border border-white/10 focus:outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 flex items-center justify-center gap-1.5 relative ${strategyType === "dynamic" ? "bg-white/12 text-white" : "bg-transparent text-white/60 hover:text-white hover:bg-white/[0.08]"}`}
                        aria-pressed={strategyType === "dynamic"}
                      >
                        <span>Scaled Strategy</span>
                        <span
                          ref={scaledHelpIconRef}
                          className="strategy-help-icon inline-flex items-center justify-center text-white/70 hover:text-white/90 shrink-0 w-4 h-4"
                          role="button"
                          tabIndex={0}
                          aria-label="What is Scaled Strategy?"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); setStrategyHelpOpen((s) => (s === "scaled" ? null : "scaled")); }}
                          onMouseEnter={() => setStrategyHelpOpen("scaled")}
                          onMouseLeave={(e) => { const to = (e.nativeEvent as MouseEvent).relatedTarget as Node | null; if (to && strategyTooltipRef.current?.contains(to)) return; setStrategyHelpOpen((s) => (s === "scaled" ? null : s)); }}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setStrategyHelpOpen((s) => (s === "scaled" ? null : "scaled")); } }}
                        >
                          ⓘ
                        </span>
                      </button>
                    </div>
                  </div>
                </div>

                <div className={`overflow-hidden transition-all duration-300 ease-out ${hasChosenDcaType && dcaMode ? "max-h-[1200px] opacity-100 mt-2" : "max-h-0 opacity-0"}`}>
                  <div>
                    <div className="mb-4 flex justify-between text-xs text-white/65">
                      <span>Current risk: <strong className="tabular-nums font-semibold" style={{ color: getRiskColor(currentRiskForPlanner) }}>{currentRiskForPlanner}</strong></span>
                      <span>{dcaMode === "accumulate" ? "Your starting buy level:" : "Your starting sell level:"} <strong className="tabular-nums" style={{ color: getRiskColor(dcaMode === "accumulate" ? buyThreshold : sellThreshold) }}>{dcaMode === "accumulate" ? buyThreshold : sellThreshold}</strong></span>
                    </div>
                    <div className="mb-6 h-2 w-full overflow-hidden rounded-full" style={{ background: `linear-gradient(to right, ${getRiskColor(0)} 0%, ${getRiskColor(50)} 50%, ${getRiskColor(100)} 100%)` }}>
                      <div className="relative h-full w-full">
                        <div className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded-full bg-white/80" style={{ left: `${dcaMode === "accumulate" ? buyThreshold : sellThreshold}%` }} aria-hidden />
                        <div className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow" style={{ left: `${currentRiskForPlanner}%`, backgroundColor: getRiskColor(currentRiskForPlanner) }} aria-hidden />
                      </div>
                    </div>

                    {/* Unified field structure — same order for Fixed and Dynamic (Fixed = Dynamic with 0% increase, field hidden) */}
                    {dcaMode === "accumulate" && (
                      <div className="space-y-4">
                        <div><label htmlFor="buy-threshold" className="mb-1 block text-xs font-medium text-white/70">Buy when risk is below</label><input id="buy-threshold" type="number" min={0} max={100} value={buyThreshold} onChange={(e) => setBuyThreshold(Number(e.target.value) ?? 30)} className="input-first w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" /></div>
                        {strategyType === "fixed" && (
                          <div><label htmlFor="frequency-acc" className="mb-1 block text-xs font-medium text-white/70">Buy Frequency</label><select id="frequency-acc" value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]">{FREQUENCY_OPTIONS.map((o) => <option key={o.value} value={o.value} className="bg-[#0a1f35] text-white">{o.label}</option>)}</select></div>
                        )}
                        <div><label htmlFor="invest-per-interval" className="mb-1 block text-xs font-medium text-white/70">Buy Amount</label><input id="invest-per-interval" type="number" min={0} step={50} value={investPerInterval} onChange={(e) => setInvestPerInterval(Number(e.target.value) || 0)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/40 focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" /></div>
                        {strategyType === "dynamic" && (
                          <ScalingRuleBlock side="buy" startingLevel={buyThreshold} interval={dynamicStepInterval} increasePct={dynamicMultiplierPct} onIntervalChange={setDynamicStepInterval} onIncreasePctChange={setDynamicMultiplierPct} />
                        )}
                        <div><label htmlFor="capital" className="mb-1 block text-xs font-medium text-white/70">Total Strategy Budget</label><input id="capital" type="number" min={0} step={100} value={capital} onChange={(e) => setCapital(Number(e.target.value) || 0)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/40 focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" /></div>
                      </div>
                    )}

                    {dcaMode === "distribute" && (
                      <div className="space-y-4">
                        <div><label htmlFor="sell-threshold" className="mb-1 block text-xs font-medium text-white/70">Sell when risk is above</label><input id="sell-threshold" type="number" min={0} max={100} value={sellThreshold} onChange={(e) => setSellThreshold(Number(e.target.value) ?? 75)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" /></div>
                        {strategyType === "fixed" ? (
                          <>
                            <div><label htmlFor="frequency-sell" className="mb-1 block text-xs font-medium text-white/70">Sell frequency</label><select id="frequency-sell" value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]">{FREQUENCY_OPTIONS.map((o) => <option key={o.value} value={o.value} className="bg-[#0a1f35] text-white">{o.label}</option>)}</select></div>
                            <div><label htmlFor="sell-amount-fixed" className="mb-1 block text-xs font-medium text-white/70">Sell amount</label><p className="mb-1 text-[11px] text-white/50">Amount in selected currency (USD/AUD) per execution.</p><input id="sell-amount-fixed" type="number" min={0} step={50} value={sellPerInterval} onChange={(e) => setSellPerInterval(Number(e.target.value) || 0)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" /></div>
                            <div><label htmlFor="btc-holdings-fixed" className="mb-1 block text-xs font-medium text-white/70">Maximum BTC to distribute</label><p className="mb-1 text-[11px] text-white/50">Optional cap. Leave 0 for no cap.</p><input id="btc-holdings-fixed" type="number" min={0} step={0.01} value={btcHoldings} onChange={(e) => setBtcHoldings(Number(e.target.value) || 0)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" placeholder="0 = no cap" /> <span className="text-[11px] text-white/50">BTC</span></div>
                          </>
                        ) : (
                          <>
                        <div><label htmlFor="sell-per-interval" className="mb-1 block text-xs font-medium text-white/70">Sell amount (per step)</label><p className="mb-1 text-[11px] text-white/50">Base sell size in currency; increases each step by your chosen %.</p><input id="sell-per-interval" type="number" min={0} step={50} value={sellPerInterval} onChange={(e) => setSellPerInterval(Number(e.target.value) || 0)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" /></div>
                        {strategyType === "dynamic" && (
                          <ScalingRuleBlock side="sell" startingLevel={sellThreshold} interval={dynamicStepInterval} increasePct={dynamicMultiplierPct} onIntervalChange={setDynamicStepInterval} onIncreasePctChange={setDynamicMultiplierPct} />
                        )}
                        <div><label htmlFor="btc-holdings" className="mb-1 block text-xs font-medium text-white/70">Maximum BTC to distribute</label><p className="mb-1 text-[11px] text-white/50">Cap on total BTC this strategy will sell across all levels.</p><input id="btc-holdings" type="number" min={0} step={0.01} value={btcHoldings} onChange={(e) => setBtcHoldings(Number(e.target.value) || 0)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/40 focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" placeholder="BTC" /> <span className="text-[11px] text-white/50">BTC</span></div>
                          </>
                        )}
                      </div>
                    )}

                    {/* Fixed: Projected Buy Behaviour; Dynamic: ladder breakdown */}
                    {hasChosenDcaType && dcaMode && (strategyType === "fixed" ? (
                      <div className="mt-6">
                        <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-4">
                          <p className="text-xs font-medium text-white/75">Projected {dcaMode === "accumulate" ? "Buy" : "Sell"} Behaviour</p>
                          <p className="mt-2 text-sm text-white/90">{symbol}{(dcaMode === "accumulate" ? investPerInterval : sellPerInterval).toLocaleString()} {dcaMode === "accumulate" ? "per execution" : (strategyType === "fixed" ? "per execution" : "per step (when risk reaches each level)")}</p>
                          <p className="mt-1 text-sm text-white/80">Planned execution when risk is between {dcaMode === "accumulate" ? <>0 – <span style={{ color: getRiskColor(buyThreshold) }}>{buyThreshold}</span></> : <><span style={{ color: getRiskColor(sellThreshold) }}>{sellThreshold}</span> – 100</>}</p>
                          {dcaMode === "accumulate" && <p className="mt-1 text-sm text-white/80">Runs every {FREQUENCY_OPTIONS.find((o) => o.value === frequency)?.label ?? frequency} while risk remains within your defined range.</p>}
                          {dcaMode === "distribute" && <p className="mt-1 text-sm text-white/80">Sells every {FREQUENCY_OPTIONS.find((o) => o.value === frequency)?.label ?? frequency} while risk remains within your defined range.</p>}
                          {dcaMode === "accumulate" && btcPriceForPlanner > 0 && (
                            <p className="mt-2 text-[11px] text-white/50">Est. BTC per buy (at current price): ~{(investPerInterval / btcPriceForPlanner).toFixed(4)} BTC</p>
                          )}
                        </div>
                      </div>
                    ) : (() => {
                      const st = strategyType ?? "fixed";
                      const builderPlan: SavedStrategy = { id: "", name: "", mode: dcaMode, strategyType: st, type: st === "fixed" ? "fixed" : "scaled", side: dcaMode === "accumulate" ? "buy" : "sell", triggerMode: st === "fixed" ? "schedule" : "risk-step", threshold: dcaMode === "accumulate" ? buyThreshold : sellThreshold, frequency, amountPerPurchase: dcaMode === "accumulate" ? investPerInterval : sellPerInterval, capital: dcaMode === "accumulate" ? capital : 0, btcHoldings: dcaMode === "distribute" ? btcHoldings : undefined, alertsEnabled: false, active: false, createdAt: "", status: "Waiting", dynamicStepInterval: (dcaMode === "distribute" || st === "dynamic") ? dynamicStepInterval : 5, dynamicMultiplierPct: st === "dynamic" ? dynamicMultiplierPct : 0 };
                      const levels = getStrategyLevels(builderPlan);
                      if (dcaMode === "distribute") {
                        const totalBtcToDistribute = levels.reduce((sum, L) => {
                          const amtFiat = getAmountAtRisk(builderPlan, L);
                          const priceAtL = getMockBtcPriceForRisk(L);
                          return sum + (priceAtL > 0 ? amtFiat / priceAtL : 0);
                        }, 0);
                        const totalProceedsFiat = levels.reduce((sum, L) => sum + getAmountAtRisk(builderPlan, L), 0);
                        const totalProceedsDisplay = currency === "AUD" ? totalProceedsFiat * USD_TO_AUD : totalProceedsFiat;
                        const sym = currency === "AUD" ? "A$" : "$";
                        return (
                          <div className="mt-6 space-y-4">
                            <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-4">
                              <p className="text-xs font-medium text-white/75">Projected Sell Breakdown</p>
                              <div className="breakdown-scroll mt-2 max-h-[280px] overflow-y-auto overflow-x-hidden rounded border border-white/5" style={{ minHeight: "4rem" }}>
                                <table className="w-full text-left text-xs">
                                  <thead className="border-b border-white/10 bg-white/5 sticky top-0">
                                    <tr>
                                      <th className="py-2 pr-3 font-medium text-white/70">Risk Level</th>
                                      <th className="py-2 pr-3 font-medium text-white/70">BTC to Sell</th>
                                      <th className="py-2 font-medium text-white/70">Est. Proceeds ({currency})</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {levels.map((risk) => {
                                      const amtFiat = getAmountAtRisk(builderPlan, risk);
                                      const priceAtRisk = getMockBtcPriceForRisk(risk);
                                      const btcToSell = priceAtRisk > 0 ? amtFiat / priceAtRisk : 0;
                                      const estProceeds = currency === "AUD" ? amtFiat * USD_TO_AUD : amtFiat;
                                      return (
                                        <tr key={risk} className="border-b border-white/5">
                                          <td className="py-2 tabular-nums" style={{ color: getRiskColor(risk) }}>{risk}</td>
                                          <td className="py-2 tabular-nums text-white/90">~{btcToSell.toFixed(4)}</td>
                                          <td className="py-2 tabular-nums text-white/90">{sym}{Math.round(estProceeds).toLocaleString()}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                              <p className="mt-4 text-[11px] font-medium text-white/60">Summary</p>
                              <p className="mt-0.5 text-sm text-white/90">Total BTC to distribute (max): ~{Math.min(totalBtcToDistribute, btcHoldings).toFixed(4)} BTC</p>
                              <p className="mt-0.5 text-[11px] text-white/60">Est. total proceeds (at current price): {sym}{Math.round(totalProceedsDisplay).toLocaleString()} {currency}</p>
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div className="mt-6 space-y-4">
                          <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-4">
                            <p className="text-xs font-medium text-white/75">Projected Buy Breakdown</p>
                            <div className="breakdown-scroll mt-2 max-h-[280px] overflow-y-auto overflow-x-hidden rounded border border-white/5 py-2 pr-2" style={{ minHeight: "4rem" }}>
                              <div className="text-sm text-white/90 space-y-1 pl-1">
                                {levels.map((risk) => {
                                  const amt = getAmountAtRisk(builderPlan, risk);
                                  return <p key={risk} className="tabular-nums">Risk <span style={{ color: getRiskColor(risk) }}>{risk}</span> → {symbol}{amt.toLocaleString()}</p>;
                                })}
                              </div>
                            </div>
                            <p className="mt-4 text-[11px] font-medium text-white/60">Capital Summary</p>
                            <p className="mt-0.5 text-sm text-white/90">Total capital required (if fully executed): {symbol}{(amountPerTrigger * triggersAvailable).toLocaleString()}</p>
                            <p className="mt-0.5 text-[11px] text-white/60">Projected BTC if fully executed: ~{(projectedBtc12Mo > 0 ? projectedBtc12Mo : (amountPerTrigger * triggersAvailable / Math.max(1, btcPriceForPlanner))).toFixed(4)} BTC</p>
                          </div>
                        </div>
                      );
                    })())}

                    <div className="mt-8 flex flex-col sm:flex-row gap-2">
                      {editingPlanId ? (
                        <>
                          <button type="button" onClick={() => setShowUpdateConfirmModal(true)} className="flex-1 rounded-lg bg-[#F28C28] py-3 text-sm font-medium text-white shadow transition-all duration-200 hover:bg-[#d97a22] focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#061826]">
                            Save Changes
                          </button>
                          <button type="button" onClick={() => { setEditingPlanId(null); setStrategyNameInput(""); setDashboardTab("savedPlan"); }} className="flex-1 rounded-lg border border-white/20 py-3 text-sm font-medium text-white/90 hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-white/20 focus:ring-offset-2 focus:ring-offset-[#061826]">
                            Cancel
                          </button>
                        </>
                      ) : canSaveAndActivate ? (
                        <button type="button" onClick={() => setShowSaveStrategyModal(true)} className="w-full rounded-lg bg-[#F28C28] py-3 text-sm font-medium text-white shadow transition-all duration-200 hover:bg-[#d97a22] focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#061826]">
                          Save Strategy
                        </button>
                      ) : (
                        <a href="#btc-dashboard" onClick={() => setAccessLevel("trial")} className="w-full inline-block rounded-lg bg-[#F28C28] py-3 text-center text-sm font-medium text-white shadow transition-all duration-200 hover:bg-[#d97a22] focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#061826]">
                          Start Free 7-Day Trial to Save
                        </a>
                      )}
                    </div>
                  </div>
                </div>

              </div>
            )}

            {/* My Strategies tab — accordion, level-based deployment */}
            {dashboardTab === "savedPlan" && (
              <div className="px-6 py-5 md:px-8 md:py-6 space-y-3">
                {savedPlans.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-white/[0.06] px-6 py-14 text-center">
                    <p className="text-base font-semibold text-white">No strategies yet</p>
                    <p className="mt-2 text-sm text-white/60 max-w-sm mx-auto">{canSaveAndActivate ? "Create your first strategy in the Strategy Builder, then save and activate it here." : "Use the Strategy Builder to design a strategy. Start your free trial to save and activate it."}</p>
                    <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
                      <button
                        type="button"
                        onClick={() => { setDashboardTab("manualPlanner"); dashboardSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
                        className="rounded-lg bg-white/10 px-5 py-2.5 text-sm font-medium text-white border border-white/20 hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-white/20 focus:ring-offset-2 focus:ring-offset-[#0a1f35]"
                      >
                        Open Strategy Builder
                      </button>
                      {!canSaveAndActivate && (
                        <a href="#btc-dashboard" onClick={() => setAccessLevel("trial")} className="rounded-lg bg-[#F28C28] px-5 py-2.5 text-sm font-medium text-white hover:bg-[#d97a22] focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#0a1f35]">
                          Start Free 7-Day Trial
                        </a>
                      )}
                    </div>
                  </div>
                ) : (
                  savedPlans.map((plan) => {
                    const isAccumulate = plan.mode === "accumulate";
                    const belowThreshold = RISK_VALUE <= plan.threshold;
                    const aboveThreshold = RISK_VALUE >= plan.threshold;
                    const inZone = isAccumulate ? belowThreshold : aboveThreshold;
                    const zoneLabel = inZone ? "Within your defined range" : "Outside your defined range";
                    const triggerNow = inZone;
                    const nextCheckDays = getNextCheckDays(plan.frequency ?? "weekly");
                    const nextCheckText = plan.frequency === "daily" ? "tomorrow" : `in ${nextCheckDays} days`;
                    const executions = plan.executions ?? [];
                    const capitalDeployed = executions.reduce((sum, e) => sum + e.amountFiat, 0);
                    const capitalRemaining = Math.max(0, (plan.capital > 0 ? plan.capital : 0) - capitalDeployed);
                    const deploymentsRemaining = plan.amountPerPurchase > 0 ? Math.floor(capitalRemaining / plan.amountPerPurchase) : 0;
                    const totalBtc = executions.reduce((s, e) => s + e.btcAmount, 0);
                    const totalFiatDeployed = executions.reduce((s, e) => s + e.amountFiat, 0);
                    const hasExecutions = executions.length > 0;
                    const isJustSaved = justSavedId === plan.id;
                    const sym = currency === "AUD" ? "A$" : "$";
                    const isExpanded = expandedPlanId === plan.id;
                    const strategyTypeLabel = plan.strategyType === "fixed" ? "Fixed" : "Scaled";
                    const modeLabel = isAccumulate ? "Accumulation" : "Distribution";
                    const levels = getDisplayLevels(plan);
                    const zoneRangeLabel = levels.length >= 2 ? `${levels[0]} → ${levels[levels.length - 1]}` : `≤ ${plan.threshold}`;
                    const executedByLevel = new Map<number, MockExecution>();
                    (plan.executions ?? []).forEach((ex) => {
                      const closest = levels.reduce((a, b) => Math.abs(a - ex.riskAtExecution) <= Math.abs(b - ex.riskAtExecution) ? a : b);
                      if (!executedByLevel.has(closest)) executedByLevel.set(closest, ex);
                    });
                    const displayCompletedLevels = getDisplayCompletedLevels(plan, levels, executedByLevel);
                    const remainingOrders = levels.filter((L) => !displayCompletedLevels.has(L)).length;
                    const allLevelsExecuted = remainingOrders === 0;
                    const nextPendingLevel = isAccumulate
                      ? levels.filter((L) => L <= RISK_VALUE && !displayCompletedLevels.has(L))[0] ?? levels[0]
                      : levels.filter((L) => L >= RISK_VALUE && !displayCompletedLevels.has(L))[0] ?? plan.threshold;
                    const currentBtcPrice = getMockBtcPriceForRisk(RISK_VALUE);
                    const nextAmount = plan.strategyType === "dynamic" ? getAmountAtRiskFromPlan(plan, nextPendingLevel) : getAmountAtRiskFromPlan(plan, RISK_VALUE);
                    const nextBtcPreview = currentBtcPrice > 0 ? nextAmount / currentBtcPrice : 0;
                    const currentValue = totalBtc * currentBtcPrice;
                    const unrealisedPl = totalFiatDeployed > 0 ? currentValue - totalFiatDeployed : 0;
                    const closestLevelToCurrent = levels.reduce((a, b) => Math.abs(a - RISK_VALUE) <= Math.abs(b - RISK_VALUE) ? a : b);
                    const currentLevelExecuted = displayCompletedLevels.has(closestLevelToCurrent);
                    const totalBtcSold = totalBtc;
                    const btcRemaining = Math.max(0, (plan.btcHoldings ?? 0) - totalBtcSold);
                    const projectedProceedsFiat = levels
                      .filter((L) => !displayCompletedLevels.has(L))
                      .reduce((sum, L) => sum + getAmountAtRiskFromPlan(plan, L), 0);
                    const projectedProceedsAUD = projectedProceedsFiat * USD_TO_AUD;
                    const proceedsRealisedAUD = totalFiatDeployed * USD_TO_AUD;

                    const scenarioPreview = isAccumulate
                      ? [
                          { risk: plan.threshold, amt: getAmountAtRiskFromPlan(plan, plan.threshold) },
                          { risk: 20, amt: getAmountAtRiskFromPlan(plan, 20) },
                        ].filter((r) => r.risk <= plan.threshold)
                      : [
                          { risk: plan.threshold, amt: getAmountAtRiskFromPlan(plan, plan.threshold) },
                          { risk: 80, amt: getAmountAtRiskFromPlan(plan, 80) },
                        ].filter((r) => r.risk >= plan.threshold);

                    return (
                      <div
                        key={plan.id}
                        ref={plan.id === justSavedId ? savedCardRef : undefined}
                        className={`rounded-xl border border-white/10 bg-white/[0.06] overflow-hidden transition-all duration-200 ${isJustSaved ? "saved-card-highlight ring-1 ring-[#F28C28]/20" : ""}`}
                      >
                        {/* Accordion header — Strategy Name · Mode · Zone · Status · Current Risk */}
                        <button
                          type="button"
                          onClick={() => setExpandedPlanId(isExpanded ? null : plan.id)}
                          className="w-full cursor-pointer px-5 py-4 flex flex-wrap items-center justify-between gap-3 text-left transition-colors duration-150 hover:bg-white/[0.04] focus:outline-none focus-visible:outline-none focus-visible:ring-0"
                          aria-expanded={isExpanded}
                        >
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
                            <span className="font-semibold text-white truncate">{plan.name}</span>
                            <span className="text-[11px] text-white/55 shrink-0">{strategyTypeLabel}</span>
                            <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-white/10 text-white/70 border border-white/10">
                              {plan.strategyType === "fixed" ? `Scheduled – ${getFrequencyLabel(plan.frequency)}` : "Risk triggered"}
                            </span>
                            <span className="text-[11px] text-white/50 shrink-0">Range {zoneRangeLabel}</span>
                            <span className={`text-[11px] font-medium shrink-0 ${!isAccumulate && btcRemaining <= 0 ? "text-white/60" : plan.strategyType === "fixed" && plan.active && !inZone ? "text-amber-400/90" : plan.active ? "text-emerald-400/90" : "text-[#F28C28]/90"}`}>{!isAccumulate && btcRemaining <= 0 ? "Inactive — No BTC remaining" : plan.strategyType === "fixed" && plan.active && !inZone ? "Paused — outside defined range" : plan.active ? "Active" : "Paused"}</span>
                            <span className="text-[11px] text-white/50 shrink-0">Risk <span className="tabular-nums font-medium" style={{ color: getRiskColor(RISK_VALUE) }}>{RISK_VALUE}</span></span>
                          </div>
                          <span className="text-white/40 transition-transform duration-200 shrink-0" style={{ transform: isExpanded ? "rotate(180deg)" : "none" }}>▼</span>
                        </button>

                        {/* Expandable body */}
                        <div className={`grid transition-all duration-200 ease-out ${isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
                          <div className="min-h-0 overflow-hidden">
                            <div className="px-5 pb-5 pt-0 border-t border-white/10 space-y-5">
                              {/* Next Action — universal NextActionCard for all strategy types */}
                              {(() => {
                                const alertsEl = (
                                  <>
                                    <span className="text-xs text-white/60">Alerts</span>
                                    <button type="button" role="switch" aria-checked={plan.alertsEnabled} onClick={(e) => { e.stopPropagation(); setPlanAlerts(plan.id, !plan.alertsEnabled); }} className={`relative h-5 w-9 shrink-0 rounded-full border transition-all duration-150 ${plan.alertsEnabled ? "border-white/30 bg-white/15" : "border-white/20 bg-white/10"}`}>
                                      <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150 ${plan.alertsEnabled ? "translate-x-4" : "translate-x-0"}`} />
                                    </button>
                                  </>
                                );
                                if (!isAccumulate && btcRemaining <= 0) return <NextActionCard header="Status" primaryLine="Inactive — No BTC remaining" alerts={alertsEl} elevated={false} />;
                                if (plan.strategyType === "fixed" && plan.active && !inZone) return <NextActionCard header="Status" primaryLine="Paused — outside defined range" secondaryLine="Waiting for risk to re-enter your defined range" alerts={alertsEl} elevated={false} />;
                                if (allLevelsExecuted) return <NextActionCard header="Status" primaryLine="Strategy fully deployed" alerts={alertsEl} elevated={false} />;
                                if (!inZone) return <NextActionCard header="Status" primaryLine={isAccumulate ? <>Waiting for risk to fall to <span style={{ color: getRiskColor(plan.threshold) }}>{plan.threshold}</span></> : <>Waiting for risk to rise to <span style={{ color: getRiskColor(plan.threshold) }}>{plan.threshold}</span></>} alerts={alertsEl} elevated={false} />;
                                if (plan.strategyType === "dynamic") return <NextActionCard header="NEXT ACTION" primaryLine={`Risk ${nextPendingLevel}`} secondaryLine={isAccumulate ? <>Buy {sym}{nextAmount.toLocaleString()} → ~{nextBtcPreview.toFixed(4)} BTC</> : <>Sell ~{nextBtcPreview.toFixed(4)} BTC → {sym}{nextAmount.toLocaleString()}</>} alerts={alertsEl} elevated />;
                                return <NextActionCard header="NEXT ACTION" primaryLine={<>{getFrequencyLabel(plan.frequency)} — Next in: {formatNextExecutionCountdown(plan.nextExecutionAt)}</>} secondaryLine={isAccumulate ? <>Buy {sym}{plan.amountPerPurchase.toLocaleString()} → ~{(plan.amountPerPurchase / Math.max(1, getMockBtcPriceForRisk(RISK_VALUE))).toFixed(4)} BTC</> : <>Sell ~{(plan.amountPerPurchase / Math.max(1, getMockBtcPriceForRisk(RISK_VALUE))).toFixed(4)} BTC → {sym}{plan.amountPerPurchase.toLocaleString()}</>} alerts={alertsEl} elevated />;
                              })()}

                              {/* Compact Strategy Progress — horizontal; BUY vs SELL metrics differ */}
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                                {isAccumulate ? (
                                  <>
                                    {plan.strategyType === "fixed" ? (
                                      <>
                                        <div><p className="text-white/50">Capital Deployed</p><p className="tabular-nums font-medium text-white">{sym}{totalFiatDeployed.toLocaleString()}</p></div>
                                        <div><p className="text-white/50">BTC Accumulated</p><p className="tabular-nums font-medium text-white">{totalBtc.toFixed(4)} BTC</p></div>
                                        <div><p className="text-white/50">Buy Amount</p><p className="tabular-nums font-medium text-white">{sym}{plan.amountPerPurchase.toLocaleString()}</p></div>
                                        {plan.frequency != null && (
                                          <div><p className="text-white/50">Frequency</p><p className="tabular-nums font-medium text-white">{plan.frequency === "daily" ? "Daily" : plan.frequency === "weekly" ? "Weekly" : plan.frequency === "fortnightly" ? "Fortnightly" : "Monthly"}</p></div>
                                        )}
                                        <div><p className="text-white/50">Executions</p><p className="tabular-nums font-medium text-white">{executions.length}</p></div>
                                      </>
                                    ) : (
                                      <>
                                        <div>
                                          <p className="text-white/50">Plan Progress</p>
                                          <p className="tabular-nums font-medium text-white">{levels.length ? Math.round((displayCompletedLevels.size / levels.length) * 100) : 0}%</p>
                                          <div className="mt-1.5 h-1 w-full rounded-full bg-white/15 overflow-hidden">
                                            <div className="h-full rounded-full bg-white/40 transition-all duration-300" style={{ width: levels.length ? `${(displayCompletedLevels.size / levels.length) * 100}%` : "0%" }} />
                                          </div>
                                        </div>
                                        <div><p className="text-white/50">Capital Deployed</p><p className="tabular-nums font-medium text-white">{sym}{totalFiatDeployed.toLocaleString()}</p></div>
                                        <div><p className="text-white/50">BTC Accumulated</p><p className="tabular-nums font-medium text-white">{totalBtc.toFixed(4)} BTC</p></div>
                                        <div><p className="text-white/50">Executions</p><p className="tabular-nums font-medium text-white">{displayCompletedLevels.size} / {levels.length}</p></div>
                                        <div><p className="text-white/50">Remaining Orders</p><p className="tabular-nums font-medium text-white">{remainingOrders}</p></div>
                                        <div><p className="text-white/50">Projected BTC (Full Plan)</p><p className="tabular-nums text-white/90">~{(levels.reduce((sum, L) => sum + getAmountAtRiskFromPlan(plan, L) / Math.max(1, getMockBtcPriceForRisk(L)), 0)).toFixed(4)} BTC</p></div>
                                      </>
                                    )}
                                  </>
                                ) : (
                                  <>
                                    {plan.strategyType === "fixed" ? (
                                      <>
                                        <div><p className="text-white/50">BTC Distributed</p><p className="tabular-nums font-medium text-white">{totalBtcSold.toFixed(4)} BTC</p></div>
                                        <div><p className="text-white/50">Cash Realised</p><p className="tabular-nums font-medium text-white">{sym}{Math.round(currency === "AUD" ? proceedsRealisedAUD : totalFiatDeployed).toLocaleString()}</p></div>
                                        <div><p className="text-white/50">Sell Amount</p><p className="tabular-nums font-medium text-white">{sym}{plan.amountPerPurchase.toLocaleString()}</p></div>
                                        {plan.frequency != null && <div><p className="text-white/50">Frequency</p><p className="tabular-nums font-medium text-white">{getFrequencyLabel(plan.frequency)}</p></div>}
                                        <div><p className="text-white/50">Executions</p><p className="tabular-nums font-medium text-white">{executions.length}</p></div>
                                        <div><p className="text-white/50">Remaining BTC to distribute</p><p className="tabular-nums font-medium text-white">{(plan.btcHoldings ?? 0) <= 0 ? "No cap" : `${btcRemaining.toFixed(4)} BTC`}</p></div>
                                      </>
                                    ) : (
                                      <>
                                        <div>
                                          <p className="text-white/50">Plan Progress</p>
                                          <p className="tabular-nums font-medium text-white">{levels.length ? Math.round((displayCompletedLevels.size / levels.length) * 100) : 0}%</p>
                                          <div className="mt-1.5 h-1 w-full rounded-full bg-white/15 overflow-hidden">
                                            <div className="h-full rounded-full bg-white/40 transition-all duration-300" style={{ width: levels.length ? `${(displayCompletedLevels.size / levels.length) * 100}%` : "0%" }} />
                                          </div>
                                        </div>
                                        <div><p className="text-white/50">BTC Distributed</p><p className="tabular-nums font-medium text-white">{totalBtcSold.toFixed(4)} BTC</p></div>
                                        <div><p className="text-white/50">Cash Realised</p><p className="tabular-nums font-medium text-white">{sym}{Math.round(currency === "AUD" ? proceedsRealisedAUD : totalFiatDeployed).toLocaleString()}</p></div>
                                        <div><p className="text-white/50">Executions</p><p className="tabular-nums font-medium text-white">{displayCompletedLevels.size} / {levels.length}</p></div>
                                        <div><p className="text-white/50">Remaining BTC to Distribute</p><p className="tabular-nums font-medium text-white">{btcRemaining.toFixed(4)} BTC</p></div>
                                        <div><p className="text-white/50">Projected Proceeds (Full Plan)</p><p className="tabular-nums text-white/90">~{sym}{Math.round(currency === "AUD" ? projectedProceedsAUD : projectedProceedsFiat).toLocaleString()}</p></div>
                                      </>
                                    )}
                                  </>
                                )}
                              </div>

                              {/* Fixed: Behaviour summary card only (no plan table); Scaled: Collapsible Deployment / Exit Plan */}
                              {plan.strategyType === "fixed" ? (
                                <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-4">
                                  <p className="text-[11px] font-medium uppercase tracking-wider text-white/60 mb-2">User-defined strategy</p>
                                  {isAccumulate ? (
                                    <>
                                      <p className="text-sm text-white/90">{sym}{plan.amountPerPurchase.toLocaleString()} per execution — planned execution based on your defined rules.</p>
                                      <p className="mt-1 text-sm text-white/80">Planned execution when risk is between 0 – <span style={{ color: getRiskColor(plan.threshold) }}>{plan.threshold}</span></p>
                                      {plan.frequency != null && <p className="mt-1 text-[11px] text-white/60">Runs every {getFrequencyLabel(plan.frequency)} while risk remains within your defined range.</p>}
                                      <p className="mt-2 text-[11px] text-white/50">Last buy: {formatLastExecution(plan.lastExecutionAt)}</p>
                                      <p className="mt-0.5 text-[11px] text-white/50">{inZone ? <>Next buy: {formatNextExecutionCountdown(plan.nextExecutionAt)}</> : "Waiting for risk to re-enter your defined range"}</p>
                                      <p className="mt-0.5 text-[11px] text-white/50">Cycle started: {formatLastExecution(plan.activatedAt ?? plan.strategyStartDate)}</p>
                                    </>
                                  ) : (
                                    <>
                                      <p className="text-sm text-white/90">{sym}{plan.amountPerPurchase.toLocaleString()} per execution — planned execution based on your defined rules.</p>
                                      <p className="mt-1 text-sm text-white/80">Planned execution when risk is between <span style={{ color: getRiskColor(plan.threshold) }}>{plan.threshold}</span> – 100</p>
                                      {plan.frequency != null && <p className="mt-1 text-[11px] text-white/60">Sells every {getFrequencyLabel(plan.frequency)} while risk remains within your defined range.</p>}
                                      <p className="mt-1 text-[11px] text-white/50">Stops automatically if available BTC reaches 0</p>
                                      <p className="mt-2 text-[11px] text-white/50">Last sell: {formatLastExecution(plan.lastExecutionAt)}</p>
                                      <p className="mt-0.5 text-[11px] text-white/50">{inZone ? <>Next sell: {formatNextExecutionCountdown(plan.nextExecutionAt)}</> : "Waiting for risk to re-enter your defined range"}</p>
                                      <p className="mt-0.5 text-[11px] text-white/50">Cycle started: {formatLastExecution(plan.activatedAt ?? plan.strategyStartDate)}</p>
                                    </>
                                  )}
                                </div>
                              ) : (
                              <div>
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); setDeploymentPlanOpenId(deploymentPlanOpenId === plan.id ? null : plan.id); }}
                                  className="flex w-full items-center gap-2 rounded-lg border border-[#F28C28]/20 bg-white/[0.04] px-3 py-2.5 text-left text-xs font-medium text-white/90 transition-colors hover:border-[#F28C28]/30 hover:bg-[#F28C28]/5 focus:outline-none focus:ring-1 focus:ring-[#F28C28]/30"
                                  aria-expanded={deploymentPlanOpenId === plan.id}
                                >
                                  <span className="text-[#F28C28] text-[10px]" aria-hidden>{deploymentPlanOpenId === plan.id ? "▼" : "▶"}</span>
                                  <span>{isAccumulate ? "Deployment Plan" : "Distribution Plan"} ({levels.length} {isAccumulate ? "Orders" : "sells"} planned)</span>
                                </button>
                                {!isAccumulate && deploymentPlanOpenId === plan.id && <p className="mt-1 text-[11px] text-white/50">Distribution schedule</p>}
                                {deploymentPlanOpenId === plan.id && (
                                  <div className="mt-2 rounded-lg border border-white/10 overflow-hidden max-h-[320px] overflow-y-auto">
                                    <table className="w-full text-left text-xs">
                                      <thead className="border-b border-white/10 bg-white/5 sticky top-0">
                                        <tr>
                                          <th className="px-3 py-2 font-medium text-white/70">Risk Level</th>
                                          {isAccumulate ? (
                                            <>
                                              <th className="px-3 py-2 font-medium text-white/70">Order Size</th>
                                              <th className="px-3 py-2 font-medium text-white/70">Est. BTC</th>
                                            </>
                                          ) : (
                                            <>
                                              <th className="px-3 py-2 font-medium text-white/70">BTC Sold</th>
                                              <th className="px-3 py-2 font-medium text-white/70">Est. Proceeds ({currency})</th>
                                            </>
                                          )}
                                          <th className="px-3 py-2 font-medium text-white/70">Status</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {levels.map((level) => {
                                          const amtFiat = getAmountAtRiskFromPlan(plan, level);
                                          const priceAtLevel = getMockBtcPriceForRisk(level);
                                          const btcAtLevel = priceAtLevel > 0 ? Math.max(0, amtFiat / priceAtLevel) : 0;
                                          const estProceedsLevel = currency === "AUD" ? (priceAtLevel * USD_TO_AUD) * btcAtLevel : priceAtLevel * btcAtLevel;
                                          const completed = displayCompletedLevels.has(level);
                                          const ex = executedByLevel.get(level);
                                          return (
                                            <tr
                                              key={level}
                                              className={`border-b border-white/5 ${completed ? "opacity-90" : ""}`}
                                              style={completed ? undefined : { borderLeftWidth: 3, borderLeftStyle: "solid", borderLeftColor: "rgba(255,255,255,0.2)" }}
                                            >
                                              <td className="px-3 py-2 tabular-nums text-white/80">{level}</td>
                                              {isAccumulate ? (
                                                <>
                                                  <td className="px-3 py-2 tabular-nums text-white/90">{sym}{amtFiat.toLocaleString()}</td>
                                                  <td className="px-3 py-2 tabular-nums text-white/90">{ex ? ex.btcAmount.toFixed(4) : `~${btcAtLevel.toFixed(4)}`}</td>
                                                </>
                                              ) : (
                                                <>
                                                  <td className="px-3 py-2 tabular-nums text-white/90">{sym}{amtFiat.toLocaleString()} (~{ex ? ex.btcAmount.toFixed(4) : btcAtLevel.toFixed(4)} BTC)</td>
                                                  <td className="px-3 py-2 tabular-nums text-white/90">{sym}{Math.round(estProceedsLevel).toLocaleString()}</td>
                                                </>
                                              )}
                                              <td className="px-3 py-2 flex items-center gap-1.5">
                                                {completed ? <span className="text-white/70" aria-hidden>✓</span> : null}
                                                <span className={completed ? "text-white/70" : "text-white/50"}>{completed ? "Completed" : "Pending"}</span>
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </div>
                              )}

                              {/* Risk bar: FIXED = current risk marker only; Scaled = level ticks + current risk */}
                              <div className="pt-2 border-t border-white/10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                                <div className="flex-1 min-w-0">
                                  <p className="text-[11px] text-white/50 mb-1">{plan.strategyType === "fixed" ? "Current risk" : (isAccumulate ? "Buy Levels" : "Sell Levels")}</p>
                                  <div className="h-2.5 w-full overflow-visible rounded-full relative" style={{ background: `linear-gradient(to right, ${getRiskColor(0)} 0%, ${getRiskColor(50)} 50%, ${getRiskColor(100)} 100%)` }}>
                                    <div className="absolute inset-0 rounded-full" aria-hidden />
                                    {plan.strategyType === "dynamic" && levels.map((level) => {
                                      const executed = displayCompletedLevels.has(level);
                                      const isNext = level === nextPendingLevel;
                                      const isFuture = isAccumulate ? level < nextPendingLevel : level > nextPendingLevel;
                                      const ex = executedByLevel.get(level);
                                      const orderSize = getAmountAtRiskFromPlan(plan, level);
                                      const markerClass = executed ? "risk-marker-completed" : isNext ? "risk-marker-next" : isFuture ? "risk-marker-future" : "risk-marker-pending";
                                      const tooltipLines = [
                                        `Risk level: ${level}`,
                                        isAccumulate ? `Order size: ${sym}${orderSize.toLocaleString()}` : `Order size: ~${(orderSize / Math.max(1, getMockBtcPriceForRisk(level))).toFixed(4)} BTC`,
                                        executed ? "Status: Filled" : isNext ? "Status: Current" : "Status: Pending",
                                        ...(ex?.date ? [`Executed: ${formatLastExecution(ex.date + "T00:00:00.000Z")}`] : []),
                                      ];
                                      return (
                                        <div key={level} className={`absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full flex items-center justify-center ${markerClass}`} style={{ left: `${level}%` }} aria-hidden title={tooltipLines.join("\n")}>
                                          {executed ? <span className="risk-marker-tick text-[9px] font-bold leading-none">✓</span> : null}
                                        </div>
                                      );
                                    })}
                                    {plan.strategyType === "fixed" && (
                                      <div className="absolute top-0 bottom-0 w-0.5 -translate-x-px bg-white/80 z-10" style={{ left: `${plan.threshold}%` }} aria-hidden title={`Range boundary ${plan.threshold}`} />
                                    )}
                                    <div className="absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-sm z-[11]" style={{ left: `${RISK_VALUE}%` }} aria-hidden title={`Current risk ${RISK_VALUE}`} />
                                  </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-3 shrink-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-white/60">{plan.active ? "Active" : "Paused"}</span>
                                    <button type="button" role="switch" aria-checked={plan.active} disabled={!canSaveAndActivate} onClick={(e) => { e.stopPropagation(); if (canSaveAndActivate) setPlanActive(plan.id, !plan.active); }} title={!canSaveAndActivate ? "Start free trial to activate" : undefined} className={`relative h-5 w-9 shrink-0 rounded-full border transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed ${plan.active ? "border-emerald-500/40 bg-emerald-500/20" : "border-[#F28C28]/40 bg-[#F28C28]/20"}`}>
                                      <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150 ${plan.active ? "translate-x-4" : "translate-x-0"}`} />
                                    </button>
                                  </div>
                                  {!isViewOnlyExpired && <button type="button" onClick={(e) => { e.stopPropagation(); loadPlanForEdit(plan); }} className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-white/80 hover:bg-white/10 transition-colors duration-150">Edit</button>}
                                  <button type="button" onClick={(e) => { e.stopPropagation(); deletePlan(plan.id); }} className="rounded-lg border border-white/15 px-3 py-1.5 text-xs font-medium text-red-300/80 hover:bg-red-500/10 transition-colors duration-150">Delete</button>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            {/* Simulator (Pro) — locked for free/expired; placeholder content for trial */}
            {dashboardTab === "backtest" && (
              <div className="flex flex-col items-center justify-center px-6 py-16 text-center md:px-8">
                {!canAccessSimulatorPro ? (
                  <>
                    <span className="mb-3 text-3xl text-white/40" aria-hidden>🔒</span>
                    <p className="text-sm font-medium text-white/80">Simulator (Pro)</p>
                    <p className="mt-2 text-xs text-white/55 max-w-sm">Start your free 7-day trial to unlock historical simulation and advanced strategy testing.</p>
                    <a href="#btc-dashboard" onClick={() => setAccessLevel("trial")} className="mt-5 inline-block rounded-lg bg-[#F28C28] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#d97a22] focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#061826]">
                      Start Free 7-Day Trial
                    </a>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium text-white/80">Simulator (Pro)</p>
                    <p className="mt-2 text-xs text-white/55">Historical simulation and advanced strategy testing.</p>
                    <p className="mt-3 max-w-sm text-xs text-white/45">Start/end date, risk band, strategy type → total capital deployed, BTC accumulated, portfolio value, return %, trade history.</p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        
      </section>
        </div>
      </div>

      {/* Strategy help tooltips — portaled to body to avoid clipping */}
      {typeof document !== "undefined" &&
        strategyHelpOpen &&
        tooltipAnchor &&
        createPortal(
          <div
            key={`strategy-tooltip-${dcaMode ?? "accumulate"}-${strategyHelpOpen}`}
            ref={strategyTooltipRef}
            className="strategy-help-tooltip strategy-help-tooltip-portal"
            role="tooltip"
            onMouseLeave={() => setStrategyHelpOpen(null)}
            style={{
              position: "fixed",
              left: tooltipAnchor.left + tooltipAnchor.width / 2,
              top: tooltipPlacement === "above" ? tooltipAnchor.top - 8 : tooltipAnchor.top + tooltipAnchor.height + 8,
              transform: `translate(-50%, ${tooltipPlacement === "above" ? "-100%" : "0"})`,
              zIndex: 9999,
            }}
          >
            <div className="strategy-help-tooltip-inner">
            {strategyHelpOpen === "fixed" && (dcaMode === "distribute" ? (
              <>
                <p className="text-xs font-semibold text-white/95 leading-snug">User-defined strategy: sells a fixed amount (in cash) at each step level in your defined range.</p>
                <p className="mt-2 text-[11px] text-white/70 leading-snug">Planned execution based on your defined rules. Example: sell $5,000 when risk is above {sellThreshold}, then at each risk interval (e.g. 55, 60, 65…).</p>
              </>
            ) : (
              <>
                <p className="text-xs font-semibold text-white/95 leading-snug">User-defined strategy: buys a fixed amount at your chosen frequency while risk remains within your defined range.</p>
                <p className="mt-2 text-[11px] text-white/70 leading-snug">Planned execution based on your defined rules. Example: buy $1,000 weekly when risk is below {buyThreshold}.</p>
              </>
            ))}
            {strategyHelpOpen === "scaled" && (dcaMode === "distribute" ? (
              <>
                <p className="text-xs font-semibold text-white/95 leading-snug">User-defined strategy: sells increasing amounts as risk levels rise within your defined range.</p>
                <p className="mt-1 text-[11px] text-white/70 leading-snug">Each risk interval increases the sell size by your chosen percentage. Planned execution based on your defined rules.</p>
              </>
            ) : (
              <>
                <p className="text-xs font-semibold text-white/95 leading-snug">User-defined strategy: buys at your chosen frequency, increasing the buy size as risk moves to earlier cycle levels in your defined range.</p>
                <p className="mt-2 text-[11px] text-white/70 leading-snug">Planned execution based on your defined rules. Example: buy $1,000 at risk {buyThreshold}, then increase buy size every 5 risk levels lower.</p>
              </>
            ))}
            </div>
          </div>,
          document.body
        )}

      <footer className="relative z-10 border-t border-white/10 bg-[#061826]/95 px-6 py-8 md:px-8">
        <div className="mx-auto max-w-3xl">
          <p className="text-center text-[11px] leading-relaxed text-white/50">
            This platform provides general market information and analytical tools. It does not provide personal financial advice.
          </p>
        </div>
      </footer>
    </>
  );
}
