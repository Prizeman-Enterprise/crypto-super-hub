"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getRiskColor, getRiskBgRgba } from "./utils/riskColors";

const MOCK_BTC_24H_CHANGE = 2.14;
const USD_TO_AUD = 1.55;
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
  /** Active risk range: strategy runs only while current risk is within [min(start,end), max(start,end)]. */
  activeRiskStart?: number;
  activeRiskEnd?: number;
  /** For scaled strategies: persisted risk levels + order sizes. Rendered from this; do not recompute on display. */
  computedOrders?: { risk: number; amountFiat: number }[];
  executions?: MockExecution[];
  /** Asset this strategy is for (default BTC for legacy). */
  asset_id?: string;
};

const SAVED_STRATEGIES_KEY = "csh-saved-strategies";

/** Per-asset data from risk_scores.json */
type AssetData = {
  asset_id: string;
  name: string;
  date?: string;
  risk_score: number;
  price: number;
  trend_value?: number;
  components?: { floor_price?: number; ceiling_price?: number; [key: string]: unknown };
  status?: string;
};

const ASSET_ORDER = ["BTC", "ETH", "SOL", "XRP"] as const;
const ASSET_COLORS: Record<string, string> = {
  BTC: "bg-[#F28C28]",
  ETH: "bg-[#627EEA]",
  SOL: "bg-emerald-500",
  XRP: "bg-[#23292F]",
};

const TOKEN_LOGOS: Record<string, string> = {
  BTC: "https://assets.coingecko.com/coins/images/1/small/bitcoin.png",
  ETH: "https://assets.coingecko.com/coins/images/279/small/ethereum.png",
  SOL: "https://assets.coingecko.com/coins/images/4128/small/solana.png",
  XRP: "https://assets.coingecko.com/coins/images/44/small/xrp-symbol-white-128.png",
};

/** Plan tier for gating. anonymous = not logged in. */
type PlanTier = "anonymous" | "free" | "trial" | "standard";

/** Derived user state for gating and UI. */
interface UserState {
  isLoggedIn: boolean;
  planTier: PlanTier;
  trialStartDate: string | null;
  trialUsed: boolean;
  emailVerified: boolean;
  /** Trial days remaining (0 if expired or not in trial). */
  trialDaysRemaining: number;
}

/** User model persisted to localStorage (no real backend yet). */
type User = {
  id: string;
  email: string;
  plan_type: "free" | "standard";
  trial_used: boolean;
  trial_started_at: string | null;
  trial_ended_at: string | null;
  subscription_status: string;
  stripe_customer_id: string | null;
  created_at: string;
  email_verified: boolean;
  referral_code?: string | null;
};

function getUserState(user: User | null, devTierOverride: PlanTier | null): UserState {
  const isLoggedIn = user !== null;
  if (!user) {
    return { isLoggedIn: false, planTier: "anonymous", trialStartDate: null, trialUsed: false, emailVerified: false, trialDaysRemaining: 0 };
  }
  if (devTierOverride && devTierOverride !== "anonymous") {
    const trialStart = user.trial_started_at ?? undefined;
    const daysRemaining = trialStart && devTierOverride === "trial"
      ? Math.max(0, 7 - Math.floor((Date.now() - new Date(trialStart).getTime()) / 86400000))
      : 0;
    return {
      isLoggedIn: true,
      planTier: devTierOverride,
      trialStartDate: user.trial_started_at,
      trialUsed: user.trial_used,
      emailVerified: user.email_verified ?? true,
      trialDaysRemaining: devTierOverride === "trial" ? (daysRemaining || 7) : 0,
    };
  }
  if (user.plan_type === "standard") {
    return { isLoggedIn: true, planTier: "standard", trialStartDate: user.trial_started_at, trialUsed: user.trial_used, emailVerified: user.email_verified ?? true, trialDaysRemaining: 0 };
  }
  const trialEndsAt = user.trial_ended_at ? new Date(user.trial_ended_at) : null;
  const trialActive = trialEndsAt !== null && trialEndsAt > new Date();
  const trialStart = user.trial_started_at ?? null;
  const trialDaysRemaining = trialActive && trialEndsAt
    ? Math.max(0, Math.ceil((trialEndsAt.getTime() - Date.now()) / 86400000))
    : 0;
  return {
    isLoggedIn: true,
    planTier: trialActive ? "trial" : "free",
    trialStartDate: trialStart,
    trialUsed: user.trial_used,
    emailVerified: user.email_verified ?? true,
    trialDaysRemaining,
  };
}

const AUTH_USER_KEY = "csh-auth-user";
/** Pending builder strategy draft used when saving through auth flow. Stored per-browser only. */
const STRATEGY_DRAFT_KEY = "pendingStrategyDraft";

/** Load user from storage (client-only). Use after mount to avoid hydration mismatch. */
function getAuthState(): User | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(AUTH_USER_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

function loadAuthUser(): User | null {
  return getAuthState();
}

/** Draft shape for strategy builder — persisted when opening auth from save flow. */
type StrategyDraft = {
  draftId: string;
  dcaMode: "accumulate" | "distribute";
  strategyType: "fixed" | "dynamic";
  activeRiskStart: number;
  activeRiskEnd: number;
  frequency: "daily" | "weekly" | "fortnightly" | "monthly";
  investPerInterval: number;
  sellPerInterval: number;
  capital: number;
  btcHoldings: number;
  dynamicMultiplierPct: number;
  dynamicStepInterval: number;
  strategyNameInput: string;
  savedAt: string;
};

function saveDraftToStorage(draft: StrategyDraft): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STRATEGY_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* ignore */
  }
}

function loadDraftFromStorage(): StrategyDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STRATEGY_DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StrategyDraft;
  } catch {
    return null;
  }
}

function clearDraft(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STRATEGY_DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

const RISK_BAND_ROW_HEIGHT = 28;
/** Risk levels for band table: whole numbers 0–100; price interpolated from risk band data. */
const RISK_BAND_LEVELS = Array.from({ length: 101 }, (_, i) => i);
const RISK_BAND_VISIBLE_EXTRA = 2;

function formatRiskValue(r: number): string {
  return r % 1 === 0 ? String(r) : String(r);
}

/** Price at risk using log interpolation: floor * (ceiling/floor)^(risk/100). */
function priceAtRiskLog(floor: number, ceiling: number, risk: number): number {
  if (floor <= 0 || ceiling <= 0) return floor || ceiling || 0;
  return floor * Math.pow(ceiling / floor, risk / 100);
}

/** Format price for display by asset (BTC/ETH whole; SOL 2 decimals; XRP 2 decimals). */
function formatPriceByAsset(assetId: string, priceUsd: number, currency: "USD" | "AUD", usdToAud: number): string {
  const sym = currency === "AUD" ? "A$" : "$";
  const p = currency === "AUD" ? priceUsd * usdToAud : priceUsd;
  if (assetId === "BTC" || assetId === "ETH") {
    return `${sym}${Math.round(p).toLocaleString()}`;
  }
  if (assetId === "SOL") return `${sym}${p.toFixed(2)}`;
  if (assetId === "XRP") return `${sym}${p.toFixed(2)}`;
  return `${sym}${p >= 1 ? Math.round(p).toLocaleString() : p.toFixed(4)}`;
}

function loadSavedStrategies(): SavedStrategy[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(SAVED_STRATEGIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedStrategy[];
    const loaded = Array.isArray(parsed) ? parsed.map((p) => {
      const st = (p as SavedStrategy).strategyType ?? "fixed";
      const defStart = p.mode === "accumulate" ? 80 : 50;
      const defEnd = p.mode === "accumulate" ? 0 : 100;
      return {
        ...p,
        asset_id: (p as SavedStrategy).asset_id ?? "BTC",
        active: p.active ?? false,
        strategyType: st,
        type: (p as SavedStrategy).type ?? (st === "fixed" ? "fixed" : "scaled"),
        side: (p as SavedStrategy).side ?? (p.mode === "accumulate" ? "buy" : "sell"),
        triggerMode: (p as SavedStrategy).triggerMode ?? (st === "fixed" ? "schedule" : "risk-step"),
        status: (p.status === "Paused" || !p.status ? "Waiting" : p.status) as SavedStrategy["status"],
        activeRiskStart: (p as SavedStrategy).activeRiskStart ?? defStart,
        activeRiskEnd: (p as SavedStrategy).activeRiskEnd ?? defEnd,
        executions: p.executions ?? [],
      };
    }) : [];
    return loaded;
  } catch {
    return [];
  }
}

export default function Home() {
  const dashboardSectionRef = useRef<HTMLElement>(null);
  const [dashboardVisible, setDashboardVisible] = useState(false);
  const [displayValue, setDisplayValue] = useState(0);
  const [countComplete, setCountComplete] = useState(false);
  const [riskValue, setRiskValue] = useState(50);
  const [assetPriceUsd, setAssetPriceUsd] = useState(103420);
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  /** Asset selected in Strategy Builder (null = show asset selector first). */
  const [builderAsset, setBuilderAsset] = useState<string | null>(null);
  const [tokenLogoFailed, setTokenLogoFailed] = useState<Set<string>>(new Set());
  const [allAssets, setAllAssets] = useState<Record<string, AssetData>>({});
  const [riskUpdatedAt, setRiskUpdatedAt] = useState<string | null>(null);

  const [currency, setCurrency] = useState<"USD" | "AUD">(() => {
    if (typeof window === "undefined") return "USD";
    try {
      const s = localStorage.getItem("csh-currency");
      if (s === "USD" || s === "AUD") return s;
    } catch { /* ignore */ }
    return "USD";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem("csh-currency", currency);
    } catch { /* ignore */ }
  }, [currency]);
  const [dashboardTab, setDashboardTab] = useState<"riskIndex" | "manualPlanner" | "savedPlan">("riskIndex");
  const [riskBandOpen, setRiskBandOpen] = useState(false);
  const [simulatedRisk, setSimulatedRisk] = useState(50);
  const [dcaMode, setDcaMode] = useState<"accumulate" | "distribute" | null>(null);

  const [capital, setCapital] = useState(10000);
  const [investPerInterval, setInvestPerInterval] = useState(1000);
  const [sellPerInterval, setSellPerInterval] = useState(500);
  const [btcHoldings, setBtcHoldings] = useState(0.5);
  const [frequency, setFrequency] = useState<"daily" | "weekly" | "fortnightly" | "monthly">("weekly");
  const [alertsEnabled, setAlertsEnabled] = useState(false);
  const [weeklySummaryEnabled, setWeeklySummaryEnabled] = useState(false);
  const [notifyEmail, setNotifyEmail] = useState("");
  const [notifySubmitted, setNotifySubmitted] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [mounted, setMounted] = useState(false);
  /** Developer override for plan tier (Settings). Set to non-null to test gating. */
  const [devPlanTierOverride, setDevPlanTierOverride] = useState<PlanTier | null>(null);
  const [devMode, setDevMode] = useState(false);
  useEffect(() => {
    setMounted(true);
    setUser(getAuthState());
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (user) localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(AUTH_USER_KEY);
  }, [user]);

  useEffect(() => {
    fetch("/api/risk")
      .then((res) => res.json())
      .then((data: { assets?: Record<string, AssetData>; updated_at?: string | null }) => {
        if (data.assets && typeof data.assets === "object") {
          setAllAssets(data.assets);
          if (data.updated_at != null) setRiskUpdatedAt(data.updated_at);
        }
      })
      .catch(() => {});
  }, []);

  /** Effective asset for risk/price sync: builder asset when in Strategy Builder, else selected asset. */
  const effectiveAsset = (dashboardTab === "manualPlanner" && builderAsset) ? builderAsset : selectedAsset;
  useEffect(() => {
    if (!effectiveAsset || !allAssets[effectiveAsset]) return;
    const a = allAssets[effectiveAsset];
    const score = typeof a.risk_score === "number" ? a.risk_score : 50;
    const price = typeof a.price === "number" ? a.price : 67000;
    setRiskValue(score);
    setAssetPriceUsd(price);
    setSimulatedRisk(Math.round(score));
    setDisplayValue(Math.round(score));
  }, [effectiveAsset, allAssets]);

  const getMockBtcPriceForRisk = (risk: number): number => {
    const base = assetPriceUsd;
    const factor = 1 + (risk / 100) * 0.8;
    return Math.round(base * factor);
  };

  /** Price at risk for an asset: uses API floor/ceiling when present, else linear mock. */
  const getPriceAtRisk = (assetId: string, risk: number): number => {
    const a = allAssets[assetId];
    if (!a?.components) return getMockBtcPriceForRisk(risk);
    const floor = Number((a.components as { floor_price?: number }).floor_price);
    const ceiling = Number((a.components as { ceiling_price?: number }).ceiling_price);
    if (Number.isFinite(floor) && Number.isFinite(ceiling) && floor > 0 && ceiling > 0) {
      return priceAtRiskLog(floor, ceiling, risk);
    }
    const base = typeof a.price === "number" ? a.price : assetPriceUsd;
    const factor = 1 + (risk / 100) * 0.8;
    return Math.round(base * factor);
  };

  /** Risk badge uses 0–100 color scale from riskColors (green → neutral → red). */
  function getRiskBadgeStyle(score: number): React.CSSProperties {
    return { color: getRiskColor(score), backgroundColor: getRiskBgRgba(score, 0.28), border: `1px solid ${getRiskColor(score)}` };
  }

  const userState = getUserState(mounted ? user : null, devPlanTierOverride);
  const isLoggedIn = userState.isLoggedIn;
  const planTier = userState.planTier;
  const canSaveAndActivate = (planTier === "trial" || planTier === "standard") && userState.emailVerified;
  /** Strategies visible but locked (free, trial ended). */
  const strategiesLocked = planTier === "free" && userState.trialUsed;
  const isStandard = planTier === "standard";
  const canAccessSimulatorPro = planTier === "standard";

  /** Dev mode: Ctrl+Shift+D / Cmd+Shift+D toggles; when on, all assets/features unlocked. */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "D") {
        e.preventDefault();
        setDevMode((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const effectiveIsStandard = devMode || isStandard;
  const effectiveCanSaveAndActivate = devMode || canSaveAndActivate;
  const effectiveStrategiesLocked = devMode ? false : strategiesLocked;
  const [authModal, setAuthModal] = useState<"login" | "register" | "register-verify" | "forgot" | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [forgotSuccess, setForgotSuccess] = useState(false);
  const [trialConfirmOpen, setTrialConfirmOpen] = useState(false);
  const [trialActivatedToast, setTrialActivatedToast] = useState(false);
  const [upgradeComingSoonToast, setUpgradeComingSoonToast] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saveGateModal, setSaveGateModal] = useState<"trial" | "upgrade" | null>(null);
  const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const profileButtonRef = useRef<HTMLButtonElement | null>(null);
  const [managePlanOpen, setManagePlanOpen] = useState(false);
  const [supportModalOpen, setSupportModalOpen] = useState(false);
  const [supportMessage, setSupportMessage] = useState("");
  const [supportSending, setSupportSending] = useState(false);
  const [supportSuccess, setSupportSuccess] = useState(false);
  const [savedPlans, setSavedPlans] = useState<SavedStrategy[]>([]);
  useEffect(() => {
    if (mounted) setSavedPlans(loadSavedStrategies());
  }, [mounted]);
  const [showSaveStrategyModal, setShowSaveStrategyModal] = useState(false);
  const [showUpdateConfirmModal, setShowUpdateConfirmModal] = useState(false);
  const [deleteConfirmPlanId, setDeleteConfirmPlanId] = useState<string | null>(null);
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  const [strategyNameInput, setStrategyNameInput] = useState("");
  const [riskNumberHover, setRiskNumberHover] = useState(false);
  const [strategyType, setStrategyType] = useState<"fixed" | "dynamic" | null>(null);
  const [activeRiskStart, setActiveRiskStart] = useState<number | "">("");
  const [activeRiskEnd, setActiveRiskEnd] = useState<number | "">("");
  const startNum = activeRiskStart === "" ? 0 : Number(activeRiskStart);
  const endNum = activeRiskEnd === "" ? 0 : Number(activeRiskEnd);
  const builderMinR = Math.min(startNum, endNum);
  const builderMaxR = Math.max(startNum, endNum);
  const hasValidRange =
    activeRiskStart !== "" && activeRiskEnd !== "" &&
    startNum >= 0 && startNum <= 100 && endNum >= 0 && endNum <= 100 &&
    (dcaMode === "accumulate" ? startNum > endNum : dcaMode === "distribute" ? startNum < endNum : true);
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
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<1 | 2 | 3 | 4 | 5>(1);
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

  // Close profile menu when clicking outside or pressing Escape.
  useEffect(() => {
    if (!profileMenuOpen) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (profileMenuRef.current?.contains(target)) return;
      if (profileButtonRef.current?.contains(target)) return;
      setProfileMenuOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProfileMenuOpen(false);
    };
    if (typeof document !== "undefined") {
      document.addEventListener("mousedown", handleClick);
      document.addEventListener("keydown", handleKey);
    }
    return () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("mousedown", handleClick);
        document.removeEventListener("keydown", handleKey);
      }
    };
  }, [profileMenuOpen]);

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
    if (typeof window === "undefined" || !mounted) return;
    if (user) try { localStorage.setItem(AUTH_USER_KEY, JSON.stringify(user)); } catch {}
    else try { localStorage.removeItem(AUTH_USER_KEY); } catch {}
  }, [mounted, user]);

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
        const { minR, maxR } = getActiveRiskBounds(p);
        const inActiveRange = riskValue >= minR && riskValue <= maxR;
        if (!p.active || !p.frequency) return p;
        if (!inActiveRange) {
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
            const price = getPriceAtRisk(p.asset_id ?? "BTC", riskValue);
            const btcNeeded = price > 0 ? p.amountPerPurchase / price : 0;
            if (btcNeeded > remaining) return p;
          }
          const price = getPriceAtRisk(p.asset_id ?? "BTC", riskValue);
          const btcAmount = price > 0 ? p.amountPerPurchase / price : 0;
          const newEx: MockExecution = {
            id: `exec-${now}-${p.id}`,
            date: nowIso.slice(0, 10),
            riskAtExecution: riskValue,
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
        const { minR, maxR } = getActiveRiskBounds(p);
        const inActiveRange = riskValue >= minR && riskValue <= maxR;
        if (!inActiveRange) return p;
        const levels = getStrategyLevels(p);
        const executedByLevel = new Map<number, MockExecution>();
        (p.executions ?? []).forEach((ex) => {
          const closest = levels.reduce((a, b) => Math.abs(a - ex.riskAtExecution) <= Math.abs(b - ex.riskAtExecution) ? a : b);
          if (!executedByLevel.has(closest)) executedByLevel.set(closest, ex);
        });
        const crossedNotExecuted = p.mode === "accumulate"
          ? levels.filter((L) => riskValue <= L && !executedByLevel.has(L))
          : levels.filter((L) => riskValue >= L && !executedByLevel.has(L));
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
          const price = getPriceAtRisk(p.asset_id ?? "BTC", level);
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

  const builderAssetId = builderAsset ?? "BTC";
  const btcPriceAtRisk = getPriceAtRisk(builderAssetId, simulatedRisk);
  const btcPrice = currency === "AUD" ? btcPriceAtRisk * USD_TO_AUD : btcPriceAtRisk;
  const symbol = currency === "AUD" ? "A$" : "$";
  const inRangeBuilder = simulatedRisk >= builderMinR && simulatedRisk <= builderMaxR;
  const strategyActive = inRangeBuilder;
  const intervalsPerYear = getIntervalsPerYear(frequency);
  const annualDeployed = dcaMode === "accumulate" && strategyActive ? Math.min(capital, investPerInterval * intervalsPerYear) : 0;
  const estimatedBtcAnnual = dcaMode === "accumulate" ? (btcPriceAtRisk > 0 ? annualDeployed / btcPriceAtRisk : 0) : 0;
  const remainingCapital = Math.max(0, capital - annualDeployed);
  const annualBtcSold = dcaMode === "distribute" && strategyActive ? Math.min(btcHoldings, (sellPerInterval / btcPriceAtRisk) * intervalsPerYear) : 0;
  const estimatedFiatFromDistribute = annualBtcSold * btcPriceAtRisk;
  const estimatedFiatDisplay = currency === "AUD" ? estimatedFiatFromDistribute * USD_TO_AUD : estimatedFiatFromDistribute;

  const currentRiskForPlanner = riskValue;
  const btcPriceForPlanner = getPriceAtRisk(builderAssetId, currentRiskForPlanner);
  const modeForCalc = dcaMode ?? "accumulate";
  const inRangePlanner = currentRiskForPlanner >= builderMinR && currentRiskForPlanner <= builderMaxR;
  const strategyActivePlanner = inRangePlanner;
  const annualDeployedPlanner = modeForCalc === "accumulate" && strategyActivePlanner ? Math.min(capital, investPerInterval * intervalsPerYear) : 0;
  const estimatedBtcPlanner = btcPriceForPlanner > 0 ? annualDeployedPlanner / btcPriceForPlanner : 0;
  const remainingCapitalPlanner = Math.max(0, capital - annualDeployedPlanner);
  const annualBtcSoldPlanner = modeForCalc === "distribute" && strategyActivePlanner ? Math.min(btcHoldings, (sellPerInterval / btcPriceForPlanner) * intervalsPerYear) : 0;
  const estimatedFiatPlanner = annualBtcSoldPlanner * btcPriceForPlanner;
  const estimatedFiatPlannerDisplay = currency === "AUD" ? estimatedFiatPlanner * USD_TO_AUD : estimatedFiatPlanner;
  const dynamicPreviewSteps = [0, 1, 2].map((i) => {
    const risk = modeForCalc === "accumulate" ? builderMaxR - i * dynamicStepInterval : builderMinR + i * dynamicStepInterval;
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
    if (!hasValidRange) return;
    const name = strategyNameInput.trim() || "My strategy";
    const amount = dcaMode === "accumulate" ? investPerInterval : sellPerInterval;
    const now = new Date().toISOString();
    const minR = builderMinR;
    const maxR = builderMaxR;
    const threshold = dcaMode === "accumulate" ? maxR : minR;
    const inActiveRange = currentRiskForPlanner >= minR && currentRiskForPlanner <= maxR;
    const isFixed = strategyType === "fixed";
    const isBuyFixed = dcaMode === "accumulate" && isFixed;
    const isSellFixed = dcaMode === "distribute" && isFixed;
    const initialExecutions: MockExecution[] = [];
    const freqMs = getFrequencyIntervalMs(frequency);
    const nextExecutionAt = inActiveRange && isFixed ? new Date(Date.now() + freqMs).toISOString() : undefined;
    /** For scaled: persist full order plan so saved view does not recompute. Only levels within active risk range. */
    let computedOrders: { risk: number; amountFiat: number }[] | undefined;
    if (!isFixed) {
      const step = strategyType === "dynamic" ? dynamicStepInterval : 5;
      const mult = (strategyType === "dynamic" ? dynamicMultiplierPct : 25) / 100;
      const base = amount;
      const levels: number[] = [];
      if (dcaMode === "accumulate") {
        for (let r = maxR; r >= minR; r -= step) levels.push(r);
      } else {
        for (let r = minR; r <= maxR; r += step) levels.push(r);
      }
      if (levels.length) {
        computedOrders = levels.map((risk, i) => ({ risk, amountFiat: Math.round(base * Math.pow(1 + mult, i)) }));
      }
    }
    if (inActiveRange && isBuyFixed) {
      const price = getPriceAtRisk(builderAsset ?? "BTC", currentRiskForPlanner);
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
    if (inActiveRange && isSellFixed) {
      const price = getPriceAtRisk(builderAsset ?? "BTC", currentRiskForPlanner);
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
      activeRiskStart: Math.max(0, Math.min(100, startNum)),
      activeRiskEnd: Math.max(0, Math.min(100, endNum)),
      frequency: isFixed ? frequency : undefined,
      amountPerPurchase: amount,
      capital: dcaMode === "accumulate" ? capital : 0,
      btcHoldings: dcaMode === "distribute" ? btcHoldings : undefined,
      alertsEnabled,
      active: inActiveRange,
      createdAt: now.slice(0, 10),
      strategyStartDate: now,
      activatedAt: inActiveRange ? now : undefined,
      lastExecutionAt: inActiveRange && isFixed ? now : undefined,
      nextExecutionAt,
      status: inActiveRange ? "Active" : "Waiting",
      dynamicStepInterval: (dcaMode === "distribute" && strategyType === "dynamic") ? dynamicStepInterval : undefined,
      dynamicMultiplierPct: strategyType === "dynamic" ? dynamicMultiplierPct : undefined,
      computedOrders,
      executions: initialExecutions,
      asset_id: builderAsset ?? selectedAsset ?? "BTC",
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
    setBuilderAsset(plan.asset_id ?? "BTC");
    setStrategyNameInput(plan.name);
    setDcaMode(plan.mode);
    setStrategyType(plan.strategyType ?? "fixed");
    setDynamicStepInterval(plan.dynamicStepInterval ?? 5);
    setDynamicMultiplierPct(plan.dynamicMultiplierPct ?? 25);
    if (plan.mode === "accumulate") {
      setCapital(plan.capital);
      setInvestPerInterval(plan.amountPerPurchase);
    } else {
      setBtcHoldings(plan.btcHoldings ?? 0.5);
      setSellPerInterval(plan.amountPerPurchase);
    }
    setFrequency((plan.frequency ?? "weekly") as "daily" | "weekly" | "fortnightly" | "monthly");
    setActiveRiskStart(plan.activeRiskStart ?? (plan.mode === "accumulate" ? 80 : 50));
    setActiveRiskEnd(plan.activeRiskEnd ?? (plan.mode === "accumulate" ? 0 : 100));
    setAlertsEnabled(plan.alertsEnabled);
    setHasChosenMode(true);
    setHasChosenDcaType(true);
    setDashboardTab("manualPlanner");
  };

  /** Persist current builder state to sessionStorage when user hits save gate (trial/upgrade). */
  const persistDraftFromCurrentState = () => {
    if (!dcaMode || !strategyType || !hasValidRange) return;
    const draft: StrategyDraft = {
      draftId: `draft-${Date.now()}`,
      dcaMode,
      strategyType,
      activeRiskStart: startNum,
      activeRiskEnd: endNum,
      frequency,
      investPerInterval,
      sellPerInterval,
      capital,
      btcHoldings,
      dynamicMultiplierPct,
      dynamicStepInterval,
      strategyNameInput: strategyNameInput.trim() || "",
      savedAt: new Date().toISOString(),
    };
    saveDraftToStorage(draft);
  };

  /** Apply draft to builder state (after login/register to restore UI). */
  const applyDraftToState = (draft: StrategyDraft) => {
    setDcaMode(draft.dcaMode);
    setStrategyType(draft.strategyType);
    setActiveRiskStart(draft.activeRiskStart);
    setActiveRiskEnd(draft.activeRiskEnd);
    setFrequency(draft.frequency);
    setInvestPerInterval(draft.investPerInterval);
    setSellPerInterval(draft.sellPerInterval);
    setCapital(draft.capital);
    setBtcHoldings(draft.btcHoldings);
    setDynamicMultiplierPct(draft.dynamicMultiplierPct);
    setDynamicStepInterval(draft.dynamicStepInterval);
    setStrategyNameInput(draft.strategyNameInput || "");
    setHasChosenMode(true);
    setHasChosenDcaType(true);
  };

  /** Save a restored draft as a new strategy (after login/register). Uses draft data only. */
  const saveDraftAsStrategy = (draft: StrategyDraft, assetId: string = builderAsset ?? selectedAsset ?? "BTC") => {
    const name = draft.strategyNameInput.trim() || "My strategy";
    const amount = draft.dcaMode === "accumulate" ? draft.investPerInterval : draft.sellPerInterval;
    const now = new Date().toISOString();
    const minR = Math.min(draft.activeRiskStart, draft.activeRiskEnd);
    const maxR = Math.max(draft.activeRiskStart, draft.activeRiskEnd);
    const threshold = draft.dcaMode === "accumulate" ? maxR : minR;
    const inActiveRange = riskValue >= minR && riskValue <= maxR;
    const isFixed = draft.strategyType === "fixed";
    const isBuyFixed = draft.dcaMode === "accumulate" && isFixed;
    const isSellFixed = draft.dcaMode === "distribute" && isFixed;
    const initialExecutions: MockExecution[] = [];
    const freqMs = getFrequencyIntervalMs(draft.frequency);
    const nextExecutionAt = inActiveRange && isFixed ? new Date(Date.now() + freqMs).toISOString() : undefined;
    let computedOrders: { risk: number; amountFiat: number }[] | undefined;
    if (!isFixed) {
      const step = draft.strategyType === "dynamic" ? draft.dynamicStepInterval : 5;
      const mult = (draft.strategyType === "dynamic" ? draft.dynamicMultiplierPct : 25) / 100;
      const base = amount;
      const levels: number[] = [];
      if (draft.dcaMode === "accumulate") {
        for (let r = maxR; r >= minR; r -= step) levels.push(r);
      } else {
        for (let r = minR; r <= maxR; r += step) levels.push(r);
      }
      if (levels.length) {
        computedOrders = levels.map((risk, i) => ({ risk, amountFiat: Math.round(base * Math.pow(1 + mult, i)) }));
      }
    }
    if (inActiveRange && isBuyFixed) {
      const price = getPriceAtRisk(assetId, riskValue);
      const btcAmount = price > 0 ? amount / price : 0;
      initialExecutions.push({ id: `exec-${Date.now()}`, date: now.slice(0, 10), riskAtExecution: riskValue, amountFiat: amount, btcAmount, pricePerBtc: price });
    }
    if (inActiveRange && isSellFixed) {
      const price = getPriceAtRisk(assetId, riskValue);
      const btcAmount = price > 0 ? amount / price : 0;
      initialExecutions.push({ id: `exec-${Date.now()}`, date: now.slice(0, 10), riskAtExecution: riskValue, amountFiat: amount, btcAmount, pricePerBtc: price });
    }
    const newPlan: SavedStrategy = {
      id: `plan-${Date.now()}`,
      name,
      asset_id: assetId,
      mode: draft.dcaMode,
      strategyType: draft.strategyType,
      type: draft.strategyType === "fixed" ? "fixed" : "scaled",
      side: draft.dcaMode === "accumulate" ? "buy" : "sell",
      triggerMode: draft.strategyType === "fixed" ? "schedule" : "risk-step",
      threshold,
      activeRiskStart: Math.max(0, Math.min(100, draft.activeRiskStart)),
      activeRiskEnd: Math.max(0, Math.min(100, draft.activeRiskEnd)),
      frequency: isFixed ? draft.frequency : undefined,
      amountPerPurchase: amount,
      capital: draft.dcaMode === "accumulate" ? draft.capital : 0,
      btcHoldings: draft.dcaMode === "distribute" ? draft.btcHoldings : undefined,
      alertsEnabled: false,
      active: inActiveRange,
      createdAt: now.slice(0, 10),
      strategyStartDate: now,
      activatedAt: inActiveRange ? now : undefined,
      lastExecutionAt: inActiveRange && isFixed ? now : undefined,
      nextExecutionAt,
      status: inActiveRange ? "Active" : "Waiting",
      dynamicStepInterval: (draft.dcaMode === "distribute" && draft.strategyType === "dynamic") ? draft.dynamicStepInterval : undefined,
      dynamicMultiplierPct: draft.strategyType === "dynamic" ? draft.dynamicMultiplierPct : undefined,
      computedOrders,
      executions: initialExecutions,
    };
    setSavedPlans((prev) => [...prev, newPlan]);
    setJustSavedId(newPlan.id);
    setDashboardTab("savedPlan");
    setShowLockInToast(true);
    clearDraft();
  };

  const openWizard = () => {
    setWizardOpen(true);
    setWizardStep(1);
    setDcaMode(null);
    setStrategyType(null);
    setActiveRiskStart("");
    setActiveRiskEnd("");
    setHasChosenMode(false);
    setHasChosenDcaType(false);
    setFrequency("weekly");
    setInvestPerInterval(1000);
    setSellPerInterval(500);
    setCapital(10000);
    setBtcHoldings(0.5);
    setDynamicStepInterval(5);
    setDynamicMultiplierPct(25);
  };

  const closeWizard = () => {
    setWizardOpen(false);
    setWizardStep(1);
  };

  const wizardCanProceedStep3 = hasValidRange;

  const handleUpdateStrategy = () => {
    if (!editingPlanId || !dcaMode || !strategyType) return;
    if (!hasValidRange) return;
    const existing = savedPlans.find((p) => p.id === editingPlanId);
    if (!existing) return;
    const amount = dcaMode === "accumulate" ? investPerInterval : sellPerInterval;
    const isFixed = strategyType === "fixed";
    const minR = builderMinR;
    const maxR = builderMaxR;
    const threshold = dcaMode === "accumulate" ? maxR : minR;
    let computedOrders: { risk: number; amountFiat: number }[] | undefined;
    if (!isFixed) {
      const step = strategyType === "dynamic" ? dynamicStepInterval : 5;
      const mult = (strategyType === "dynamic" ? dynamicMultiplierPct : 25) / 100;
      const base = amount;
      const levels: number[] = [];
      if (dcaMode === "accumulate") {
        for (let r = maxR; r >= minR; r -= step) levels.push(r);
      } else {
        for (let r = minR; r <= maxR; r += step) levels.push(r);
      }
      if (levels.length) {
        computedOrders = levels.map((risk, i) => ({ risk, amountFiat: Math.round(base * Math.pow(1 + mult, i)) }));
      }
    }
    const updated: SavedStrategy = {
      ...existing,
      name: strategyNameInput.trim() || existing.name,
      threshold,
      activeRiskStart: Math.max(0, Math.min(100, startNum)),
      activeRiskEnd: Math.max(0, Math.min(100, endNum)),
      amountPerPurchase: amount,
      frequency: isFixed ? frequency : undefined,
      capital: dcaMode === "accumulate" ? capital : 0,
      btcHoldings: dcaMode === "distribute" ? btcHoldings : undefined,
      alertsEnabled,
      dynamicStepInterval: (dcaMode === "distribute" && strategyType === "dynamic") ? dynamicStepInterval : undefined,
      dynamicMultiplierPct: strategyType === "dynamic" ? dynamicMultiplierPct : undefined,
      computedOrders: isFixed ? existing.computedOrders : computedOrders,
      executions: existing.executions ?? [],
      asset_id: existing.asset_id ?? "BTC",
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
    const { minR, maxR } = getActiveRiskBounds(plan);
    const inActiveRange = riskValue >= minR && riskValue <= maxR;
    if (inActiveRange && plan.active) return "ACTIVE";
    return "WAITING FOR ENTRY";
  }

  function getStatusTile(plan: SavedStrategy): "ACTIVE" | "WAITING FOR ENTRY" {
    const { minR, maxR } = getActiveRiskBounds(plan);
    const inActiveRange = riskValue >= minR && riskValue <= maxR;
    if (inActiveRange && plan.active) return "ACTIVE";
    return "WAITING FOR ENTRY";
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

  /** Normalized active risk bounds (0–100). start/end can be in either order. */
  function getActiveRiskBounds(plan: SavedStrategy): { minR: number; maxR: number; start: number; end: number } {
    const start = Math.max(0, Math.min(100, plan.activeRiskStart ?? (plan.mode === "accumulate" ? 80 : 50)));
    const end = Math.max(0, Math.min(100, plan.activeRiskEnd ?? (plan.mode === "accumulate" ? 0 : 100)));
    return { minR: Math.min(start, end), maxR: Math.max(start, end), start, end };
  }

  function isRiskWithinActiveRange(plan: SavedStrategy, risk: number): boolean {
    const { minR, maxR } = getActiveRiskBounds(plan);
    return risk >= minR && risk <= maxR;
  }

  /** Level-based view: levels generated ONLY from active risk range + step. Accumulate: maxR down to minR; distribute: minR up to maxR. */
  function getStrategyLevels(plan: SavedStrategy): number[] {
    const { minR, maxR } = getActiveRiskBounds(plan);
    const step = plan.dynamicStepInterval ?? 5;
    const raw: number[] = [];
    if (plan.mode === "accumulate") {
      for (let r = maxR; r >= minR; r -= step) raw.push(r);
    } else {
      for (let r = minR; r <= maxR; r += step) raw.push(r);
    }
    return raw.length ? raw : [minR];
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
    const { minR, maxR } = getActiveRiskBounds(plan);
    const firstLevel = plan.mode === "accumulate" ? maxR : minR;
    if (plan.mode === "accumulate") {
      if (plan.strategyType === "dynamic" && plan.dynamicStepInterval != null && plan.dynamicMultiplierPct != null) {
        const steps = Math.max(0, Math.floor((firstLevel - risk) / plan.dynamicStepInterval));
        return Math.round(plan.amountPerPurchase * Math.pow(1 + plan.dynamicMultiplierPct / 100, steps));
      }
      return plan.amountPerPurchase;
    }
    if (plan.strategyType === "dynamic" && plan.dynamicStepInterval != null && plan.dynamicMultiplierPct != null) {
      const steps = Math.max(0, Math.floor((risk - firstLevel) / plan.dynamicStepInterval));
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
    if (startVal === riskValue) return;
    const start = performance.now();
    const dur = 250;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setSimulatedRisk(Math.round(startVal + (riskValue - startVal) * eased));
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
              <button type="button" onClick={() => { setShowSaveStrategyModal(false); setStrategyNameInput(""); }} className="flex-1 rounded-lg border border-white/20 py-2 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent disabled:opacity-60" disabled={lockingIn}>Cancel</button>
              <button type="button" onClick={() => { setLockingIn(true); setTimeout(() => { handleSaveStrategy(); setLockingIn(false); }, 400); }} className={`flex-1 rounded-lg py-2 text-sm font-medium text-white transition-all duration-200 ${lockingIn ? "bg-[#F28C28] scale-105" : "bg-[#F28C28] hover:bg-[#F5A623] hover:scale-105"}`} disabled={lockingIn || !hasValidRange}>
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
              <button type="button" onClick={() => setShowUpdateConfirmModal(false)} className="flex-1 rounded-lg border border-white/20 py-2 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent">Cancel</button>
              <button type="button" onClick={handleUpdateStrategy} className="flex-1 rounded-lg bg-[#F28C28] py-2 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F5A623] hover:scale-105 focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#0a1f35]">Confirm changes</button>
            </div>
          </div>
        </div>
      )}
      {deleteConfirmPlanId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="delete-strategy-title">
          <div className="w-full max-w-sm rounded-xl border border-white/15 bg-[#0a1f35] p-6 shadow-2xl">
            <h3 id="delete-strategy-title" className="text-sm font-semibold text-white">Delete strategy?</h3>
            <p className="mt-3 text-sm text-white/80">This will permanently remove this strategy and its execution history.</p>
            <div className="mt-6 flex gap-2">
              <button type="button" onClick={() => setDeleteConfirmPlanId(null)} className="flex-1 rounded-lg border border-white/20 py-2 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent">Cancel</button>
              <button type="button" onClick={() => { deletePlan(deleteConfirmPlanId); setDeleteConfirmPlanId(null); }} className="flex-1 rounded-lg border border-red-400/60 py-2 text-sm font-medium text-red-300 transition-all duration-200 hover:bg-red-500/25 hover:border-red-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 focus:ring-offset-[#0a1f35]">Delete</button>
            </div>
          </div>
        </div>
      )}
      {/* Trial activation confirmation */}
      {trialConfirmOpen && user && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="trial-confirm-title">
          <div className="w-full max-w-sm rounded-xl border border-white/15 bg-[#0a1f35] p-6 shadow-2xl">
            <h2 id="trial-confirm-title" className="text-sm font-semibold text-white">Start your 7-day free trial?</h2>
            <p className="mt-2 text-sm text-white/80">You&apos;ll be able to save and manage BTC strategies for 7 days. No credit card required. You can only activate this trial once.</p>
            <div className="mt-6 flex gap-2">
              <button type="button" onClick={() => setTrialConfirmOpen(false)} className="flex-1 rounded-lg border border-white/20 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent">Cancel</button>
              <button
                type="button"
                onClick={() => {
                  if (user && !user.email_verified) {
                    setTrialConfirmOpen(false);
                    setAuthModal("register-verify");
                    return;
                  }
                  const now = new Date();
                  const trialEnds = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
                  setUser((u) => (u ? { ...u, trial_used: true, trial_started_at: now.toISOString(), trial_ended_at: trialEnds.toISOString() } : null));
                  setTrialConfirmOpen(false);
                  setTrialActivatedToast(true);
                  setTimeout(() => setTrialActivatedToast(false), 4000);
                  const draft = loadDraftFromStorage();
                  if (draft) { applyDraftToState(draft); saveDraftAsStrategy(draft); setDashboardTab("savedPlan"); }
                }}
                className="flex-1 rounded-lg bg-[#F28C28] py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F5A623] hover:scale-105"
              >
                Start trial
              </button>
            </div>
          </div>
        </div>
      )}
      {trialActivatedToast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-emerald-600/95 px-4 py-2.5 text-sm font-medium text-white shadow-lg">
          Trial activated! You have 7 days to save and manage strategies.
        </div>
      )}
      {/* Upgrade to Standard — placeholder (TODO: Stripe) */}
      {upgradeModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="upgrade-modal-title">
          <div className="w-full max-w-sm rounded-xl border border-white/15 bg-[#0a1f35] p-6 shadow-2xl">
            <h2 id="upgrade-modal-title" className="text-sm font-semibold text-white">Upgrade to Standard</h2>
            <p className="mt-2 text-sm text-white/80">$19 AUD/month. Save, edit, and delete strategies. Payment integration coming soon.</p>
            <div className="mt-6 flex gap-2">
              <button type="button" onClick={() => setUpgradeModalOpen(false)} className="flex-1 rounded-lg border border-white/20 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent">Cancel</button>
              <button
                type="button"
                onClick={() => {
                  // Mock upgrade: mark user as Standard so entitlements unlock.
                  setUser((u) =>
                    u
                      ? {
                          ...u,
                          plan_type: "standard",
                        }
                      : null,
                  );
                  setUpgradeModalOpen(false);
                }}
                className="flex-1 rounded-lg bg-[#F28C28] py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F5A623] hover:scale-105"
              >
                Confirm (mock)
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Contact support */}
      {supportModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="support-modal-title">
          <div className="w-full max-w-md rounded-xl border border-white/15 bg-[#0a1f35] p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <h2 id="support-modal-title" className="text-sm font-semibold text-white">
              Contact support
            </h2>
            <p className="mt-2 text-xs text-white/70">
              If you have any issues or feedback, email <span className="font-mono text-white/85">cryptosuperhub@gmail.com</span> or message our team below.
            </p>
            <form
              className="mt-4 space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!supportMessage.trim()) return;
                setSupportSending(true);
                setSupportSuccess(false);
                try {
                  const payload = {
                    userId: user?.id ?? null,
                    email: user?.email ?? "",
                    message: supportMessage.trim(),
                    createdAt: new Date().toISOString(),
                  };
                  const res = await fetch("/api/support", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                  });
                  if (!res.ok) throw new Error(`Support API returned ${res.status}`);
                  setSupportSuccess(true);
                  setSupportMessage("");
                } catch {
                  setSupportSuccess(false);
                } finally {
                  setSupportSending(false);
                }
              }}
            >
              <textarea
                value={supportMessage}
                onChange={(e) => setSupportMessage(e.target.value)}
                className="mt-1 w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/35 focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28] min-h-[110px]"
                placeholder="Share as much detail as you can so we can help."
              />
              <div className="flex items-center justify-between gap-3">
                {supportSuccess && <p className="text-xs text-emerald-300/90">Message sent. We&apos;ll be in touch.</p>}
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => {
                    setSupportModalOpen(false);
                    setSupportSuccess(false);
                    setSupportMessage("");
                  }}
                  className="rounded-lg border border-white/20 px-3 py-2 text-xs font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={supportSending || !supportMessage.trim()}
                  className="rounded-lg bg-[#F28C28] px-4 py-2 text-xs font-medium text-white transition-all duration-200 hover:bg-[#F5A623] hover:scale-105 disabled:opacity-60 disabled:hover:scale-100"
                >
                  {supportSending ? "Sending…" : "Send message"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* Manage plan — subscription (tier-based UI) */}
      {managePlanOpen && user && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="manage-plan-title">
          <div className="w-full max-w-md rounded-xl border border-white/15 bg-[#0a1f35] p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <h2 id="manage-plan-title" className="text-sm font-semibold text-white">MANAGE SUBSCRIPTION</h2>
            <p className="mt-1 text-xs text-white/60">Current plan: {planTier === "standard" ? "Standard" : planTier === "trial" ? `Trial (${userState.trialDaysRemaining} days remaining)` : "Free"}.</p>

            <div className="mt-5 space-y-4">
              {planTier === "free" && !userState.trialUsed && (
                <>
                  {!userState.emailVerified ? (
                    <>
                      <p className="text-sm text-white/80">Please verify your email to start your free trial.</p>
                      <button type="button" onClick={() => { setManagePlanOpen(false); setAuthModal("register-verify"); }} className="w-full rounded-lg bg-[#F28C28] py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F5A623] hover:scale-105">Verify email</button>
                    </>
                  ) : (
                  <button
                    type="button"
                    onClick={() => { setTrialConfirmOpen(true); setManagePlanOpen(false); }}
                    className="w-full rounded-lg bg-[#F28C28] py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F5A623] hover:scale-105"
                  >
                    Start 7-day free trial
                  </button>
                  )}
                  <button
                    type="button"
                    onClick={() => { setUpgradeComingSoonToast(true); setTimeout(() => setUpgradeComingSoonToast(false), 3000); }}
                    className="w-full rounded-lg border border-white/20 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent"
                  >
                    Upgrade to Standard — $19 AUD/month
                  </button>
                </>
              )}
              {planTier === "free" && userState.trialUsed && (
                <>
                  <button
                    type="button"
                    onClick={() => { setUpgradeComingSoonToast(true); setTimeout(() => setUpgradeComingSoonToast(false), 3000); }}
                    className="w-full rounded-lg bg-[#F28C28] py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F5A623] hover:scale-105"
                  >
                    Upgrade to Standard — $19 AUD/month
                  </button>
                  <p className="text-[11px] text-white/50">Your free trial has been used.</p>
                </>
              )}
              {planTier === "trial" && (
                <>
                  <p className="text-sm text-white/80">Trial: {userState.trialDaysRemaining} days remaining</p>
                  <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                    <div className="h-full bg-emerald-500/60 rounded-full" style={{ width: `${Math.max(0, 100 - (userState.trialDaysRemaining / 7) * 100)}%` }} />
                  </div>
                  <button
                    type="button"
                    onClick={() => { setUpgradeComingSoonToast(true); setTimeout(() => setUpgradeComingSoonToast(false), 3000); }}
                    className="w-full rounded-lg border border-white/20 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent"
                  >
                    Upgrade to Standard — $19 AUD/month
                  </button>
                </>
              )}
              {planTier === "standard" && (
                <>
                  <p className="text-sm text-white/80">Standard plan active — $19 AUD/month</p>
                  <button type="button" className="w-full rounded-lg border border-white/20 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent">
                    Manage billing
                  </button>
                  <button type="button" className="w-full rounded-lg border border-red-400/60 py-2.5 text-sm font-medium text-red-300 transition-all duration-200 hover:bg-red-500/25 hover:border-red-400">
                    Downgrade to Free
                  </button>
                  <p className="text-[11px] text-white/50">You’ll keep your account but lose Standard features (e.g. all assets, save strategies).</p>
                </>
              )}
            </div>

            <button type="button" onClick={() => setManagePlanOpen(false)} className="mt-6 w-full rounded-lg border border-white/20 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent">Close</button>
          </div>
        </div>
      )}
      {upgradeComingSoonToast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-[#0a1f35] border border-white/20 px-4 py-2.5 text-sm text-white/90 shadow-lg">
          Coming soon — payment integration in progress.
        </div>
      )}
      {/* Auth modal: Login / Register / Forgot */}
      {authModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
          <div className="w-full max-w-sm rounded-xl border border-white/15 bg-[#0a1f35] p-6 shadow-2xl">
            <h2 id="auth-modal-title" className="text-sm font-semibold text-white">{authModal === "login" ? "Log in" : authModal === "register" ? "Create account" : authModal === "register-verify" ? "Verify your email" : "Reset password"}</h2>
            {authModal === "login" && (
              <form
                className="mt-4 space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const email = (e.currentTarget.elements.namedItem("login-email") as HTMLInputElement).value;
                  const password = (e.currentTarget.elements.namedItem("login-password") as HTMLInputElement).value;
                  if (!email || !password) return;
                  setAuthLoading(true);
                  // TODO: Replace with real login API; load user by email from backend.
                  setTimeout(() => {
                    const now = new Date();
                    const stored = getAuthState();
                    const newUser: User = stored && stored.email === email ? stored : {
                      id: "1",
                      email,
                      plan_type: "free",
                      trial_used: false,
                      trial_started_at: null,
                      trial_ended_at: null,
                      subscription_status: "active",
                      stripe_customer_id: null,
                      created_at: now.toISOString(),
                      email_verified: true,
                      referral_code: null,
                    };
                    setUser(newUser);
                    const draft = loadDraftFromStorage();
                    if (draft) {
                      applyDraftToState(draft);
                      saveDraftAsStrategy(draft);
                      setDashboardTab("savedPlan");
                    }
                    setAuthModal(null);
                    setAuthLoading(false);
                  }, 400);
                }}
              >
                <input id="login-email" type="email" placeholder="Email" required className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/40 focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" autoComplete="email" />
                <input id="login-password" type="password" placeholder="Password" required className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/40 focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" autoComplete="current-password" />
                <button type="submit" disabled={authLoading} className="w-full rounded-lg bg-[#F28C28] py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F5A623] hover:scale-105 disabled:opacity-70 disabled:hover:scale-100">{authLoading ? "Signing in…" : "Log in"}</button>
                <div className="flex flex-col gap-1">
                  <button type="button" onClick={() => { setForgotSuccess(false); setAuthModal("forgot"); }} className="w-full text-left text-sm text-white/60 hover:text-white">Forgot password?</button>
                  <button type="button" onClick={() => setAuthModal("register")} className="w-full text-left text-sm text-white/60 hover:text-white">Create account</button>
                </div>
              </form>
            )}
            {authModal === "register" && (
              <form
                noValidate
                className="mt-4 space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const email = (e.currentTarget.elements.namedItem("reg-email") as HTMLInputElement).value;
                  const password = (e.currentTarget.elements.namedItem("reg-password") as HTMLInputElement).value;
                  const referral = (e.currentTarget.elements.namedItem("reg-referral") as HTMLInputElement | null)?.value ?? "";
                  if (!email || !password) return;
                  setAuthLoading(true);
                  const now = new Date();
                  // TODO: Replace with real signup API + email verification (e.g. Resend, SendGrid, Supabase).
                  setTimeout(() => {
                    const newUser: User = {
                      id: "1",
                      email,
                      plan_type: "free",
                      trial_used: false,
                      trial_started_at: null,
                      trial_ended_at: null,
                      subscription_status: "active",
                      stripe_customer_id: null,
                      created_at: now.toISOString(),
                      email_verified: false,
                      referral_code: referral || null,
                    };
                    setUser(newUser);
                    setAuthModal("register-verify");
                    setAuthLoading(false);
                  }, 400);
                }}
              >
                <input id="reg-email" name="reg-email" type="email" placeholder="Email" required className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/40 focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" autoComplete="email" />
                <input id="reg-password" name="reg-password" type="password" placeholder="Password" required className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/40 focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" autoComplete="new-password" />
                <input id="reg-referral" name="reg-referral" type="text" placeholder="Referral code (optional)" className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/35 focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" />
                <button type="submit" disabled={authLoading} className="w-full rounded-lg bg-[#F28C28] py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F5A623] hover:scale-105 disabled:opacity-70 disabled:hover:scale-100">{authLoading ? "Creating account…" : "Create account"}</button>
                <p className="text-[11px] text-white/50">7-day free trial after you verify your email. No card required.</p>
                <button type="button" onClick={() => setAuthModal("login")} className="w-full text-left text-sm text-white/60 hover:text-white">Already have an account? Log in</button>
              </form>
            )}
            {authModal === "register-verify" && user && (
              <div className="mt-4 space-y-4">
                <p className="text-sm text-white/90">We&apos;ve sent a verification link to <span className="font-medium text-white">{user.email}</span>. Please check your inbox and click the link to activate your account.</p>
                <div className="flex flex-col gap-2">
                  <button type="button" className="w-full rounded-lg border border-white/20 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent">Resend email</button>
                  <button type="button" onClick={() => setAuthModal("register")} className="w-full rounded-lg border border-white/20 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent">Use a different email</button>
                  {devMode && (
                    <button
                      type="button"
                      onClick={() => { setUser((u) => (u ? { ...u, email_verified: true } : null)); setAuthModal(null); const draft = loadDraftFromStorage(); if (draft) { applyDraftToState(draft); saveDraftAsStrategy(draft); setDashboardTab("savedPlan"); } }}
                      className="mt-2 rounded-lg bg-white/10 py-2 text-xs font-medium text-white/70 hover:bg-white/15 border border-white/20"
                    >
                      Verify now (dev)
                    </button>
                  )}
                </div>
              </div>
            )}
            {authModal === "forgot" && (
              forgotSuccess ? (
                <div className="mt-4 space-y-3">
                  <p className="text-sm text-white/90">If an account exists, we&apos;ve emailed a reset link.</p>
                  <button type="button" onClick={() => { setForgotSuccess(false); setAuthModal("login"); }} className="w-full rounded-lg border border-white/20 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent">Back to log in</button>
                </div>
              ) : (
                <form className="mt-4 space-y-3" onSubmit={(e) => { e.preventDefault(); setForgotSuccess(true); }}>
                  <input type="email" placeholder="Email" required className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/40 focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" autoComplete="email" />
                  <button type="submit" className="w-full rounded-lg bg-[#F28C28] py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F5A623] hover:scale-105">Send reset link</button>
                  <button type="button" onClick={() => { setForgotSuccess(false); setAuthModal("login"); }} className="w-full text-sm text-white/60 hover:text-white">Back to log in</button>
                </form>
              )
            )}
            <button type="button" onClick={() => { setAuthModal(null); setForgotSuccess(false); }} className="mt-3 w-full text-sm text-white/50 hover:text-white">Close</button>
          </div>
        </div>
      )}
      {/* Settings (when logged in) — profile dropdown / Manage plan link */}
      {settingsOpen && user && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="settings-title">
          <div className="w-full max-w-md rounded-xl border border-white/15 bg-[#0a1f35] p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <h2 id="settings-title" className="text-sm font-semibold text-white">Settings</h2>
            <div className="mt-4 space-y-4">
              <div>
                <p className="text-[11px] font-medium text-white/60 uppercase tracking-wider">Account</p>
                <p className="mt-1 text-sm text-white/90">{user.email}</p>
                <p className="mt-0.5 text-[11px] text-white/50">Plan: {planTier === "standard" ? "Standard" : planTier === "trial" ? `Trial (${userState.trialDaysRemaining} days left)` : "Free"}{user.trial_used ? " (trial used)" : ""}</p>
              </div>
              <div>
                <p className="text-[11px] font-medium text-white/60 uppercase tracking-wider">Subscription</p>
                <button type="button" onClick={() => { setSettingsOpen(false); setManagePlanOpen(true); }} className="mt-1 rounded-lg border border-white/20 px-3 py-1.5 text-xs font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent">Manage plan</button>
              </div>
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <p className="text-[11px] font-medium text-amber-200/80 uppercase tracking-wider">Developer</p>
                <p className="mt-1 text-xs text-white/60">Override plan tier for testing:</p>
                <select value={devPlanTierOverride ?? ""} onChange={(e) => setDevPlanTierOverride(e.target.value ? (e.target.value as PlanTier) : null)} className="mt-2 w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]">
                  <option value="">Use real plan</option>
                  <option value="free">Free</option>
                  <option value="trial">Trial</option>
                  <option value="standard">Standard</option>
                </select>
              </div>
              <div className="pt-4 border-t border-white/10">
                <button type="button" onClick={() => { if (typeof window !== "undefined" && window.confirm("Permanently delete your account and all data?")) { setUser(null); setSettingsOpen(false); } }} className="rounded-lg border border-red-400/60 px-3 py-1.5 text-sm font-medium text-red-300 transition-all duration-200 hover:bg-red-500/25 hover:border-red-400">Delete account</button>
              </div>
            </div>
            <button type="button" onClick={() => setSettingsOpen(false)} className="mt-6 w-full rounded-lg border border-white/20 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent">Close</button>
          </div>
        </div>
      )}
      {/* Strategy Builder (create strategy) modal */}
      {wizardOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="wizard-title">
          <div className="w-full max-w-md rounded-xl border border-white/15 bg-[#0a1f35] shadow-2xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="px-6 pt-5 pb-2 border-b border-white/10 flex items-start justify-between gap-2">
              <div>
                <h2 id="wizard-title" className="text-sm font-semibold text-white">Create Strategy</h2>
                <p className="mt-1 text-[11px] text-white/50">Step {wizardStep} of 5</p>
              </div>
              <button type="button" onClick={closeWizard} className="rounded p-1.5 text-white/60 hover:text-white hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-white/20" aria-label="Close">×</button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {wizardStep === 1 && (
                <div>
                  <h3 className="mb-3 text-sm font-medium text-white">What are you building?</h3>
                  <div className="space-y-2">
                    <button type="button" onClick={() => { setDcaMode("accumulate"); setHasChosenMode(true); setWizardStep(2); }} className={`w-full rounded-lg border px-4 py-3 text-left transition-all border-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F28C28] ${dcaMode === "accumulate" ? "bg-white/12 border-white/20 text-white" : "bg-white/[0.04] text-white/70 hover:bg-white/[0.08] hover:text-white"}`}>
                      <span className="text-xs font-medium">Accumulate (Buy)</span>
                      <p className="mt-1 text-[11px] text-white/60">Build a structured accumulation plan within your chosen risk range.</p>
                    </button>
                    <button type="button" onClick={() => { setDcaMode("distribute"); setHasChosenMode(true); setWizardStep(2); }} className={`w-full rounded-lg border px-4 py-3 text-left transition-all border-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F28C28] ${dcaMode === "distribute" ? "bg-white/12 border-white/20 text-white" : "bg-white/[0.04] text-white/70 hover:bg-white/[0.08] hover:text-white"}`}>
                      <span className="text-xs font-medium">Distribute (Sell)</span>
                      <p className="mt-1 text-[11px] text-white/60">Build a structured distribution plan within your chosen risk range.</p>
                    </button>
                  </div>
                </div>
              )}
              {wizardStep === 2 && dcaMode && (
                <div>
                  <h3 className="mb-3 text-sm font-medium text-white">Strategy type</h3>
                  <div className="space-y-2">
                    <button type="button" onClick={() => { setStrategyType("fixed"); setHasChosenDcaType(true); setWizardStep(3); }} className={`w-full rounded-lg border px-4 py-3 text-left transition-all border-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F28C28] ${strategyType === "fixed" ? "bg-white/12 border-white/20 text-white" : "bg-white/[0.04] text-white/70 hover:bg-white/[0.08] hover:text-white"}`}>
                      <span className="text-xs font-medium">Fixed</span>
                      <p className="mt-1 text-[11px] text-white/60">Executes the same order size at the set frequency within the risk range.</p>
                    </button>
                    <button type="button" onClick={() => { setStrategyType("dynamic"); setHasChosenDcaType(true); setWizardStep(3); }} className={`w-full rounded-lg border px-4 py-3 text-left transition-all border-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#F28C28] ${strategyType === "dynamic" ? "bg-white/12 border-white/20 text-white" : "bg-white/[0.04] text-white/70 hover:bg-white/[0.08] hover:text-white"}`}>
                      <span className="text-xs font-medium">Scaled</span>
                      <p className="mt-1 text-[11px] text-white/60">Executes at defined risk levels within your active range. Order size adjusts per level.</p>
                    </button>
                  </div>
                </div>
              )}
              {wizardStep === 3 && dcaMode && (
                <div>
                  <h3 className="mb-1 text-sm font-medium text-white">Active Risk Range</h3>
                  <p className="mb-3 text-[11px] text-white/70">Orders execute only when current risk is inside this range.</p>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label htmlFor="wizard-start-risk" className="mb-1 block text-[11px] font-medium text-white/60">Start risk</label>
                      <input id="wizard-start-risk" type="number" min={0} max={100} value={activeRiskStart === "" ? "" : activeRiskStart} onChange={(e) => { const v = e.target.value; setActiveRiskStart(v === "" ? "" : Math.max(0, Math.min(100, Number(v) || 0))); }} placeholder="0–100" className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white tabular-nums placeholder-white/30 focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" />
                    </div>
                    <div>
                      <label htmlFor="wizard-end-risk" className="mb-1 block text-[11px] font-medium text-white/60">End risk</label>
                      <input id="wizard-end-risk" type="number" min={0} max={100} value={activeRiskEnd === "" ? "" : activeRiskEnd} onChange={(e) => { const v = e.target.value; setActiveRiskEnd(v === "" ? "" : Math.max(0, Math.min(100, Number(v) || 0))); }} placeholder="0–100" className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white tabular-nums placeholder-white/30 focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" />
                    </div>
                  </div>
                  <p className="text-[11px] text-white/70 mb-2">Active range: <span className="tabular-nums font-medium text-white/90">{activeRiskStart !== "" && activeRiskEnd !== "" ? `${builderMinR} → ${builderMaxR}` : "—"}</span></p>
                  <div className="relative h-2 w-full rounded-full overflow-hidden" style={{ background: `linear-gradient(to right, ${getRiskColor(0)} 0%, ${getRiskColor(50)} 50%, ${getRiskColor(100)} 100%)` }} aria-hidden>
                    <div className="absolute inset-0 rounded-full bg-black/30" style={{ left: 0, width: `${builderMinR}%` }} />
                    <div className="absolute inset-0 rounded-full bg-black/30" style={{ left: `${builderMaxR}%`, right: 0 }} />
                    <div className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-white/30" style={{ left: `${startNum}%` }} />
                    <div className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-white/30" style={{ left: `${endNum}%` }} />
                  </div>
                  <p className="mt-2 text-[10px] text-white/50">
                    {activeRiskStart === "" || activeRiskEnd === "" ? "Enter both values to continue." : null}
                    {activeRiskStart !== "" && activeRiskEnd !== "" && dcaMode === "accumulate" && startNum <= endNum ? "Start risk must be greater than end risk (e.g. 30 → 10)." : null}
                    {activeRiskStart !== "" && activeRiskEnd !== "" && dcaMode === "distribute" && startNum >= endNum ? "Start risk must be less than end risk (e.g. 50 → 80)." : null}
                    {hasValidRange ? "Values 0–100." : null}
                  </p>
                </div>
              )}
              {wizardStep === 4 && dcaMode && strategyType && hasValidRange && (
                <div className="space-y-4">
                  <h3 className="text-sm font-medium text-white mb-3">Execution Plan</h3>
                  {dcaMode === "accumulate" && (
                    <>
                      {strategyType === "fixed" && (
                        <>
                          <div>
                            <label htmlFor="wizard-buy-amount" className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-white/60">
                              Amount executed per order
                              <span className="text-white/50 cursor-help" title="Amount executed each time your strategy triggers." aria-label="Help">ⓘ</span>
                            </label>
                            <input id="wizard-buy-amount" type="number" min={0} step={50} value={investPerInterval} onChange={(e) => setInvestPerInterval(Number(e.target.value) || 0)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" />
                          </div>
                          <div>
                            <label htmlFor="wizard-freq" className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-white/60">
                              Execution frequency
                              <span className="text-white/50 cursor-help" title="How often orders execute while risk remains in range." aria-label="Help">ⓘ</span>
                            </label>
                            <select id="wizard-freq" value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]">{FREQUENCY_OPTIONS.map((o) => <option key={o.value} value={o.value} className="bg-[#0a1f35] text-white">{o.label}</option>)}</select>
                          </div>
                        </>
                      )}
                      {strategyType === "dynamic" && (
                        <>
                          <div>
                            <label htmlFor="wizard-buy-amount" className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-white/60">
                              Base order
                              <span className="text-white/50 cursor-help" title="Order size at your starting risk level." aria-label="Help">ⓘ</span>
                            </label>
                            <input id="wizard-buy-amount" type="number" min={0} step={50} value={investPerInterval} onChange={(e) => setInvestPerInterval(Number(e.target.value) || 0)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" />
                          </div>
                          <div className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3">
                            <p className="text-[11px] font-medium uppercase tracking-wider text-white/60 mb-2">Scaling rule</p>
                            <p className="mb-3 text-[11px] text-white/70">
                              When risk moves every {dynamicStepInterval} points from starting level <span style={{ color: getRiskColor(builderMaxR) }}>{builderMaxR}</span>, adjust order size by {dynamicMultiplierPct}%.
                            </p>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="mb-1 block text-[11px] font-medium text-white/60">Risk interval</label>
                                <input type="number" min={1} max={20} value={dynamicStepInterval} onChange={(e) => setDynamicStepInterval(Number(e.target.value) || 5)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" title="Distance between execution levels inside your active range." />
                              </div>
                              <div>
                                <label className="mb-1 block text-[11px] font-medium text-white/60">Increase per level (%)</label>
                                <input type="number" min={0} max={100} value={dynamicMultiplierPct} onChange={(e) => setDynamicMultiplierPct(Number(e.target.value) || 25)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" title="How order size increases or decreases at each level." />
                              </div>
                            </div>
                          </div>
                        </>
                      )}
                      <div>
                        <label htmlFor="wizard-capital" className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-white/60">
                          Total budget
                          <span className="text-white/50 cursor-help" title="Maximum capital allocated to this strategy." aria-label="Help">ⓘ</span>
                        </label>
                        <input id="wizard-capital" type="number" min={0} step={100} value={capital} onChange={(e) => setCapital(Number(e.target.value) || 0)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" />
                      </div>
                    </>
                  )}
                  {dcaMode === "distribute" && (
                    <>
                      {strategyType === "fixed" && (
                        <>
                          <div>
                            <label htmlFor="wizard-sell-amount" className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-white/60">
                              Amount executed per order
                              <span className="text-white/50 cursor-help" title="Amount executed each time your strategy triggers." aria-label="Help">ⓘ</span>
                            </label>
                            <input id="wizard-sell-amount" type="number" min={0} step={50} value={sellPerInterval} onChange={(e) => setSellPerInterval(Number(e.target.value) || 0)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" />
                          </div>
                          <div>
                            <label htmlFor="wizard-sell-freq" className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-white/60">
                              Execution frequency
                              <span className="text-white/50 cursor-help" title="How often orders execute while risk remains in range." aria-label="Help">ⓘ</span>
                            </label>
                            <select id="wizard-sell-freq" value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]">{FREQUENCY_OPTIONS.map((o) => <option key={o.value} value={o.value} className="bg-[#0a1f35] text-white">{o.label}</option>)}</select>
                          </div>
                        </>
                      )}
                      {strategyType === "dynamic" && (
                        <>
                          <div>
                            <label htmlFor="wizard-sell-amount" className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-white/60">
                              Base order
                              <span className="text-white/50 cursor-help" title="Order size at your starting risk level." aria-label="Help">ⓘ</span>
                            </label>
                            <input id="wizard-sell-amount" type="number" min={0} step={50} value={sellPerInterval} onChange={(e) => setSellPerInterval(Number(e.target.value) || 0)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" />
                          </div>
                          <div className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-3">
                            <p className="text-[11px] font-medium uppercase tracking-wider text-white/60 mb-2">Scaling rule</p>
                            <p className="mb-3 text-[11px] text-white/70">
                              When risk moves every {dynamicStepInterval} points from starting level <span style={{ color: getRiskColor(builderMinR) }}>{builderMinR}</span>, adjust order size by {dynamicMultiplierPct}%.
                            </p>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <label className="mb-1 block text-[11px] font-medium text-white/60">Risk interval</label>
                                <input type="number" min={1} max={20} value={dynamicStepInterval} onChange={(e) => setDynamicStepInterval(Number(e.target.value) || 5)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" title="Distance between execution levels inside your active range." />
                              </div>
                              <div>
                                <label className="mb-1 block text-[11px] font-medium text-white/60">Increase per level (%)</label>
                                <input type="number" min={0} max={100} value={dynamicMultiplierPct} onChange={(e) => setDynamicMultiplierPct(Number(e.target.value) || 25)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" title="How order size increases or decreases at each level." />
                              </div>
                            </div>
                          </div>
                        </>
                      )}
                      <div>
                        <label htmlFor="wizard-btc" className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-white/60">
                          Total budget
                          <span className="text-white/50 cursor-help" title="Maximum capital allocated to this strategy." aria-label="Help">ⓘ</span>
                        </label>
                        <input id="wizard-btc" type="number" min={0} step={0.01} value={btcHoldings} onChange={(e) => setBtcHoldings(Number(e.target.value) || 0)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" placeholder="Max BTC (0 = no cap)" />
                      </div>
                    </>
                  )}
                </div>
              )}
              {wizardStep === 5 && dcaMode && strategyType && hasValidRange && (() => {
                const st = strategyType ?? "fixed";
                const builderPlan: SavedStrategy = { id: "", name: "", mode: dcaMode, strategyType: st, type: st === "fixed" ? "fixed" : "scaled", side: dcaMode === "accumulate" ? "buy" : "sell", triggerMode: st === "fixed" ? "schedule" : "risk-step", threshold: dcaMode === "accumulate" ? builderMaxR : builderMinR, activeRiskStart: Math.max(0, Math.min(100, startNum)), activeRiskEnd: Math.max(0, Math.min(100, endNum)), frequency, amountPerPurchase: dcaMode === "accumulate" ? investPerInterval : sellPerInterval, capital: dcaMode === "accumulate" ? capital : 0, btcHoldings: dcaMode === "distribute" ? btcHoldings : undefined, alertsEnabled: false, active: false, createdAt: "", status: "Waiting", dynamicStepInterval: (dcaMode === "distribute" || st === "dynamic") ? dynamicStepInterval : 5, dynamicMultiplierPct: st === "dynamic" ? dynamicMultiplierPct : 0 };
                const summaryLevels = getStrategyLevels(builderPlan);
                const totalCapitalRequired = dcaMode === "accumulate" ? summaryLevels.reduce((s, L) => s + getAmountAtRisk(builderPlan, L), 0) : summaryLevels.reduce((s, L) => s + getAmountAtRisk(builderPlan, L), 0);
                const assetId = builderAsset ?? "BTC";
                const projectedBtc = dcaMode === "accumulate" ? summaryLevels.reduce((s, L) => s + getAmountAtRisk(builderPlan, L) / Math.max(1, getPriceAtRisk(assetId, L)), 0) : summaryLevels.reduce((s, L) => s + getAmountAtRisk(builderPlan, L) / Math.max(1, getPriceAtRisk(assetId, L)), 0);
                return (
                <div>
                  <h3 className="text-sm font-medium text-white mb-3">Review your strategy</h3>
                  <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-4 space-y-3 text-[13px]">
                    <p className="text-white/90"><span className="text-white/55">Mode</span> {dcaMode === "accumulate" ? "Accumulate (Buy)" : "Distribute (Sell)"}</p>
                    <p className="text-white/90"><span className="text-white/55">Type</span> {strategyType === "fixed" ? "Fixed" : "Scaled"}</p>
                    <div>
                      <p className="text-white/55 mb-1.5">Active range</p>
                      <div className="relative h-2 w-full rounded-full overflow-hidden mb-1.5" style={{ background: `linear-gradient(to right, ${getRiskColor(0)} 0%, ${getRiskColor(50)} 50%, ${getRiskColor(100)} 100%)` }}>
                        <div className="absolute inset-0 rounded-full bg-black/40" style={{ left: 0, width: `${builderMinR}%` }} />
                        <div className="absolute inset-0 rounded-full bg-black/40" style={{ left: `${builderMaxR}%`, right: 0 }} />
                      </div>
                      <p className="text-white/90 tabular-nums"><span style={{ color: getRiskColor(builderMinR) }}>{builderMinR}</span> → <span style={{ color: getRiskColor(builderMaxR) }}>{builderMaxR}</span></p>
                    </div>
                    {dcaMode === "accumulate" && <p className="text-white/90"><span className="text-white/55">Amount per order</span> {symbol}{investPerInterval.toLocaleString()} {strategyType === "dynamic" ? "base, +" + dynamicMultiplierPct + "% per level" : "per execution"}</p>}
                    {dcaMode === "distribute" && <p className="text-white/90"><span className="text-white/55">Amount per order</span> {symbol}{sellPerInterval.toLocaleString()} {strategyType === "dynamic" ? "base, +" + dynamicMultiplierPct + "% per level" : "per execution"}</p>}
                    {strategyType === "fixed" && <p className="text-white/90"><span className="text-white/55">Execution frequency</span> {FREQUENCY_OPTIONS.find((o) => o.value === frequency)?.label ?? frequency}</p>}
                    {dcaMode === "accumulate" && <p className="text-white/90"><span className="text-white/55">Total budget</span> {symbol}{capital.toLocaleString()}</p>}
                    {dcaMode === "distribute" && <p className="text-white/90"><span className="text-white/55">Total budget</span> {btcHoldings > 0 ? btcHoldings + " " + (builderAsset ?? "BTC") : "No cap"}</p>}
                    {strategyType === "dynamic" && summaryLevels.length > 0 && (
                      <div className="pt-2 border-t border-white/10">
                        <p className="text-white/55 mb-2">Projected deployment</p>
                        <div className="max-h-[200px] overflow-y-auto rounded border border-white/5">
                          <table className="w-full text-left text-[11px]">
                            <thead className="bg-white/5 border-b border-white/10 sticky top-0">
                              <tr>
                                <th className="px-2 py-1.5 font-medium text-white/70">Risk</th>
                                <th className="px-2 py-1.5 font-medium text-white/70">{dcaMode === "accumulate" ? "Amount" : "Amount"}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {summaryLevels.map((r) => (
                                <tr key={r} className="border-b border-white/5">
                                  <td className="px-2 py-1.5 tabular-nums" style={{ color: getRiskColor(r) }}>{r}</td>
                                  <td className="px-2 py-1.5 tabular-nums text-white/90">{symbol}{getAmountAtRisk(builderPlan, r).toLocaleString()}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        <p className="mt-2 text-white/80"><span className="text-white/55">Total capital required</span> {symbol}{Math.round(totalCapitalRequired).toLocaleString()}</p>
                        <p className="text-[11px] text-white/70">Projected {builderAsset ?? "BTC"} (full plan) ~{projectedBtc.toFixed(4)} {builderAsset ?? "BTC"}</p>
                      </div>
                    )}
                    {strategyType === "fixed" && dcaMode === "accumulate" && (
                      <p className="text-white/80"><span className="text-white/55">Total capital allocated</span> {symbol}{capital.toLocaleString()}</p>
                    )}
                  </div>
                </div>
                );
              })()}
            </div>
            <div className="px-6 py-4 border-t border-white/10 flex gap-2 flex-wrap">
              {wizardStep > 1 ? (
                <button type="button" onClick={() => setWizardStep((s) => Math.max(1, s - 1) as 1 | 2 | 3 | 4 | 5)} className="rounded-lg border border-white/20 py-2 px-4 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent focus:outline-none focus:ring-2 focus:ring-white/20">
                  Back
                </button>
              ) : null}
              <div className="flex-1" />
              {wizardStep < 5 ? (
                wizardStep >= 3 ? (
                  <button
                    type="button"
                    onClick={() => { if (wizardStep === 3 && wizardCanProceedStep3) setWizardStep(4); else if (wizardStep === 4) setWizardStep(5); }}
                    disabled={wizardStep === 3 && !wizardCanProceedStep3}
                    className="rounded-lg bg-[#F28C28] py-2 px-4 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F5A623] hover:scale-105 focus:outline-none focus:ring-2 focus:ring-[#F28C28] disabled:opacity-50 disabled:pointer-events-none disabled:hover:scale-100"
                  >
                    Next
                  </button>
                ) : null
              ) : (
                <>
                  {effectiveCanSaveAndActivate ? (
                    <button
                      type="button"
                      onClick={() => {
                        closeWizard();
                        setShowSaveStrategyModal(true);
                        setStrategyNameInput("");
                      }}
                      className="rounded-lg bg-[#F28C28] py-2 px-4 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F5A623] hover:scale-105 focus:outline-none focus:ring-2 focus:ring-[#F28C28]"
                    >
                      Save Strategy
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        persistDraftFromCurrentState();
                        if (!isLoggedIn) { setAuthModal("register"); return; }
                        if (planTier === "free" && !userState.emailVerified) { setAuthModal("register-verify"); return; }
                        if (planTier === "free" && userState.trialUsed) { setManagePlanOpen(true); return; }
                        setTrialConfirmOpen(true);
                      }}
                      className="rounded-lg bg-[#F28C28] py-2 px-4 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F5A623] hover:scale-105 focus:outline-none focus:ring-2 focus:ring-[#F28C28] inline-block text-center"
                    >
                      {!isLoggedIn ? "Create account to save" : planTier === "free" && !userState.emailVerified ? "Please verify your email to start your free trial" : planTier === "free" && userState.trialUsed ? "Upgrade to Standard to save strategies" : "Start your 7-day free trial to save strategies"}
                    </button>
                  )}
                </>
              )}
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
            @keyframes logoFloat {
              0%, 100% { transform: translateY(0); }
              50% { transform: translateY(-6px); }
            }
            .hero-logo-float {
              animation: logoFloat 8s ease-in-out infinite;
            }
            @keyframes ctaGlow {
              0%, 100% { box-shadow: 0 0 0 0 rgba(242,140,40,0.25); }
              50% { box-shadow: 0 0 24px 2px rgba(242,140,40,0.2); }
            }
            .cta-glow {
              animation: ctaGlow 3s ease-in-out infinite;
            }
            @media (prefers-reduced-motion: reduce) {
              .hero-logo-float { animation: none; }
              .cta-glow { animation: none; }
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
        {devMode && (
          <div className="fixed bottom-4 right-4 z-30 rounded-md bg-amber-500/90 px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-wider text-black shadow-lg" aria-live="polite">
            DEV MODE
          </div>
        )}
        <div className="pointer-events-none fixed inset-0 z-[1] opacity-[0.015]" style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")", backgroundRepeat: "repeat" }} aria-hidden />
        {/* Top navigation — Cowen-inspired */}
        <header className="relative z-20 flex items-center justify-between px-6 py-4 md:px-8">
          <div className="flex items-center gap-3 min-w-0">
            <img src="/brand/csh-mark-inverse.svg" alt="" className="h-8 w-auto shrink-0 md:h-9" aria-hidden />
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-white truncate">CRYPTO SUPER HUB</span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => dashboardSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="rounded-lg border border-white/20 px-4 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#0E2A47]"
            >
              Explore Framework
            </button>
            {isLoggedIn ? (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setProfileMenuOpen((open) => !open)}
                  className="flex h-9 w-9 items-center justify-center rounded-full border border-white/20 text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent focus:outline-none focus:ring-2 focus:ring-white/70"
                  aria-label="Account menu"
                  aria-haspopup="menu"
                  aria-expanded={profileMenuOpen}
                  ref={profileButtonRef}
                >
                  <span className="h-3.5 w-3.5 rounded-full bg-white/95" />
                </button>
                {profileMenuOpen && (
                  <div
                    ref={profileMenuRef}
                    className="absolute right-0 mt-2 w-56 rounded-xl border border-white/15 bg-[#061826] py-2 shadow-xl shadow-black/50 ring-1 ring-black/40"
                    role="menu"
                    aria-label="Account menu"
                  >
                    <div className="px-3 pb-2 text-xs text-white/60">
                      <p className="font-medium text-white/80 truncate">{user?.email}</p>
                      <p className="mt-0.5 text-[11px] text-white/50">
                        Plan: {user?.plan_type === "standard" ? "Standard" : strategiesLocked ? "Free (trial ended)" : "Free / Trial"}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left text-sm text-white/85 hover:bg-white/5"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        setManagePlanOpen(true);
                      }}
                      role="menuitem"
                    >
                      Manage plan
                    </button>
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left text-sm text-white/85 hover:bg-white/5"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        setSupportModalOpen(true);
                      }}
                      role="menuitem"
                    >
                      Contact support
                    </button>
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left text-sm text-white/85 hover:bg-white/5"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        setSettingsOpen(true);
                      }}
                      role="menuitem"
                    >
                      Account settings
                    </button>
                    <div className="my-1 border-t border-white/10" />
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left text-sm text-white/85 hover:bg-white/5"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        setUser(null);
                      }}
                      role="menuitem"
                    >
                      Sign out
                    </button>
                    <button
                      type="button"
                      className="w-full rounded-lg border border-red-400/60 px-3 py-2 text-left text-sm font-medium text-red-300 transition-all duration-200 hover:bg-red-500/25 hover:border-red-400"
                      onClick={() => {
                        setProfileMenuOpen(false);
                        if (typeof window !== "undefined" && window.confirm("Permanently delete your account and all data?")) {
                          setUser(null);
                        }
                      }}
                      role="menuitem"
                    >
                      Delete account
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAuthModal("login")}
                className="rounded-lg border border-white/20 px-4 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#0E2A47]"
              >
                Log in
              </button>
            )}
          </div>
        </header>

        <div
          className="relative flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center overflow-hidden px-6 bg-[#061826]"
        >
          <main className="relative z-10 flex max-w-2xl flex-col items-center text-center">
            <img
              src="/brand/csh-mark-inverse.svg"
              alt=""
              className="hero-logo-float relative z-10 mb-8 block w-[168px] h-auto"
              style={{ filter: "drop-shadow(0 0 20px rgba(242, 140, 40, 0.15))" }}
              aria-hidden
            />
            <h1 className="hero-item mt-2 text-3xl font-bold leading-tight text-white md:text-4xl lg:text-5xl uppercase tracking-[0.16em]" style={{ animationDelay: "80ms" }}>
              CRYPTO SUPER HUB
            </h1>
            <p className="hero-item mt-4 mx-auto max-w-md text-lg md:text-xl leading-snug text-white/90" style={{ animationDelay: "120ms" }}>
              <span className="text-white">A structured framework for </span>
              <span
                className="bg-clip-text text-transparent font-medium"
                style={{ backgroundImage: "linear-gradient(90deg, #ffffff 0%, #ffffff 10%, #F28C28 60%, #F28C28 100%)" }}
              >
                digital asset investing.
              </span>
            </p>
            <div className="hero-item mt-8" style={{ animationDelay: "200ms" }}>
              <button
                type="button"
                onClick={() => dashboardSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className="rounded-lg bg-[#F28C28] px-6 py-3 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F5A623] hover:scale-105 focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#0E2A47]"
              >
                Explore Framework
              </button>
            </div>
          </main>
        </div>

      <section
        id="btc-dashboard"
        ref={dashboardSectionRef}
        className="relative z-10 min-h-[60vh] bg-[#061826] px-6 pt-24 pb-28 md:pt-32 md:pb-36"
      >
        <div className="pointer-events-none absolute inset-0 opacity-100" style={{ background: "radial-gradient(ellipse 110% 75% at 50% 50%, rgba(255,255,255,0.06) 0%, transparent 55%)" }} aria-hidden />
        <div
          className={`relative mx-auto max-w-3xl transition-all duration-700 ease-out ${
            dashboardVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-8"
          }`}
        >
          <div className="absolute -inset-6 rounded-2xl opacity-60 blur-xl" style={{ background: "radial-gradient(ellipse 80% 50% at 50% 40%, rgba(255,255,255,0.06) 0%, transparent 70%)" }} aria-hidden />
          <div className="relative rounded-xl border border-white/15 bg-white/[0.09] shadow-2xl shadow-black/25 backdrop-blur-sm ring-1 ring-white/10" style={{ boxShadow: "0 0 0 1px rgba(255,255,255,0.08) inset, 0 25px 50px -12px rgba(0,0,0,0.3)" }}>
            {/* Top-level header: app name + trial badge + currency */}
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4 md:px-8 md:py-5">
              <div className="flex items-center gap-3 min-w-0">
                <h2 className="text-lg font-semibold text-white md:text-xl truncate">Dashboard</h2>
                {planTier === "trial" && userState.trialDaysRemaining > 0 && (
                  <span className="shrink-0 rounded-full bg-emerald-500/20 px-2.5 py-1 text-xs font-medium text-emerald-300">Trial: {userState.trialDaysRemaining} day{userState.trialDaysRemaining !== 1 ? "s" : ""} remaining</span>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <div className="flex rounded-lg border border-white/15 bg-white/5 p-0.5">
                  <button type="button" onClick={() => setCurrency("USD")} className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${currency === "USD" ? "bg-[#F28C28] text-white" : "text-white/70 hover:text-white"}`} aria-pressed={currency === "USD"}>USD</button>
                  <button type="button" onClick={() => setCurrency("AUD")} className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${currency === "AUD" ? "bg-[#F28C28] text-white" : "text-white/70 hover:text-white"}`} aria-pressed={currency === "AUD"}>AUD</button>
                </div>
              </div>
            </div>

            {/* Top-level tabs */}
            <div className="flex border-b border-white/10 p-1">
              {[
                { id: "riskIndex" as const, label: "Risk Index" },
                { id: "manualPlanner" as const, label: "Strategy Builder" },
                { id: "savedPlan" as const, label: "My Strategies" },
              ].map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    if (id === "riskIndex") setSelectedAsset(null);
                    if (id === "manualPlanner") setBuilderAsset(null);
                    setDashboardTab(id);
                  }}
                  className={`flex flex-1 items-center justify-center gap-1 rounded-lg py-2.5 text-xs font-medium transition-all duration-200 ease ${
                    dashboardTab === id ? "bg-white/10 text-white" : "text-white/60 hover:bg-white/[0.08] hover:text-white"
                  }`}
                  style={{ borderRadius: 8 }}
                  aria-pressed={dashboardTab === id}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Risk Index tab: list or asset detail with ← All Assets inside content */}
            {dashboardTab === "riskIndex" && selectedAsset === null && (
              <>
                <div className="px-6 py-5 md:px-8 md:py-6 space-y-0">
                  {ASSET_ORDER.map((id) => {
                    const a = allAssets[id];
                    if (!a) return null;
                    const score = typeof a.risk_score === "number" ? a.risk_score : 50;
                    const price = typeof a.price === "number" ? a.price : 0;
                    const isLocked = !effectiveIsStandard && id !== "BTC";
                    const logoFailed = tokenLogoFailed.has(id);
                    return (
                      <div key={a.asset_id} className="relative">
                        <button
                          type="button"
                          onClick={() => {
                            if (isLocked) {
                              if (planTier === "anonymous") { setAuthModal("register"); }
                              else { setManagePlanOpen(true); }
                            } else setSelectedAsset(a.asset_id);
                          }}
                          className={`w-full flex items-center gap-4 px-4 py-4 rounded-lg border border-white/10 bg-white/[0.03] transition-all duration-200 ease text-left cursor-pointer ${isLocked ? "opacity-90" : "hover:bg-[rgba(255,255,255,0.03)]"}`}
                        >
                          <span className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white overflow-hidden ${ASSET_COLORS[id] ?? "bg-white/20"}`}>
                            {!logoFailed && TOKEN_LOGOS[id] ? (
                              <img src={TOKEN_LOGOS[id]} alt="" className="h-full w-full object-cover" onError={() => setTokenLogoFailed((s) => new Set(s).add(id))} />
                            ) : null}
                            <span className={logoFailed || !TOKEN_LOGOS[id] ? "absolute inset-0 flex items-center justify-center" : "sr-only"}>{a.asset_id}</span>
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="font-medium text-white truncate">{a.name}</p>
                            <p className="text-xs text-white/55">{a.asset_id}</p>
                          </div>
                          {isLocked ? (
                            <span className="shrink-0 flex items-center gap-1.5 text-xs text-white/50">
                              <span aria-hidden>🔒</span> Standard plan
                            </span>
                          ) : (
                            <>
                              <p className="text-sm font-semibold tabular-nums text-white shrink-0">
                                {formatPriceByAsset(a.asset_id, price, currency, USD_TO_AUD)}
                              </p>
                              <p className="text-sm tabular-nums text-white/50 shrink-0 w-10 text-center">—</p>
                              <span className="shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums" style={getRiskBadgeStyle(score)}>
                                {score % 1 === 0 ? score : score.toFixed(1)}
                              </span>
                            </>
                          )}
                        </button>
                        {isLocked && (
                          <div role="button" tabIndex={0} onClick={() => { if (planTier === "anonymous") setAuthModal("register"); else setManagePlanOpen(true); }} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (planTier === "anonymous") setAuthModal("register"); else setManagePlanOpen(true); } }} className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/40 backdrop-blur-[2px] cursor-pointer" aria-label={planTier === "anonymous" ? "Create a free account to get started" : "Upgrade to Standard to unlock all assets"}>
                            <span className="text-xs text-white/80 flex items-center gap-1.5">🔒 Standard plan</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="px-6 pb-5 md:px-8 md:pb-6 pt-0">
                  <p className="text-xs text-white/50">
                    Last updated: {riskUpdatedAt ? new Date(riskUpdatedAt).toLocaleString() : "—"}
                  </p>
                </div>
              </>
            )}

            {/* Risk Index tab — asset detail (with ← All Assets link inside content) */}
            {dashboardTab === "riskIndex" && selectedAsset !== null && (
              <div className="px-6 py-5 md:px-8 md:py-6">
                <button type="button" onClick={() => setSelectedAsset(null)} className="mb-4 text-sm font-medium text-white/80 hover:text-white transition-colors">
                  ← All Assets
                </button>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 border-b border-white/10 pb-5">
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wider text-white/50">{selectedAsset ?? "BTC"} Price{simulatedRisk !== riskValue ? " (at risk " + simulatedRisk + ")" : ""}</p>
                    <p className="mt-1.5 text-lg font-bold tabular-nums text-white md:text-xl">
                      {formatPriceByAsset(selectedAsset ?? "BTC", getPriceAtRisk(selectedAsset ?? "BTC", simulatedRisk), currency, USD_TO_AUD)}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wider text-white/50">24h Change</p>
                    <p className={`mt-1.5 text-lg font-bold tabular-nums md:text-xl ${MOCK_BTC_24H_CHANGE >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                      {MOCK_BTC_24H_CHANGE >= 0 ? "+" : ""}{MOCK_BTC_24H_CHANGE}%
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wider text-white/50">Current {selectedAsset ?? "BTC"} Risk</p>
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
                  Long-term regression of {allAssets[selectedAsset!]?.name ?? selectedAsset} price data measures relative market risk. Lower values historically reflect earlier cycle positioning. Higher values reflect later cycle positioning.
                </p>
                <div className="mt-5 border-t border-white/10 pt-5">
                  <button
                    type="button"
                    onClick={() => setRiskBandOpen((o) => !o)}
                    className="flex w-full cursor-pointer items-center justify-between rounded-lg px-2 py-2.5 text-left text-xs font-medium text-white/70 transition-colors hover:bg-white/[0.06] hover:text-white focus:outline-none focus-visible:ring-0"
                    aria-expanded={riskBandOpen}
                  >
                    <span>View Full {selectedAsset ?? "BTC"} Risk Band</span>
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
                            <th className="px-4 py-3 font-medium w-1/2 text-center">{selectedAsset ?? "BTC"} PRICE</th>
                          </tr>
                        </thead>
                        <tbody style={{ height: RISK_BAND_LEVELS.length * RISK_BAND_ROW_HEIGHT }}>
                          {(() => {
                            const assetId = selectedAsset ?? "BTC";
                            const closestLevel = RISK_BAND_LEVELS.reduce((prev, curr) => Math.abs(curr - simulatedRisk) < Math.abs(prev - simulatedRisk) ? curr : prev);
                            const containerHeight = riskBandContainerRef.current?.clientHeight ?? 288;
                            const visibleCount = Math.ceil(containerHeight / RISK_BAND_ROW_HEIGHT) + RISK_BAND_VISIBLE_EXTRA * 2;
                            const visibleStart = Math.max(0, Math.floor(riskBandScrollTop / RISK_BAND_ROW_HEIGHT) - RISK_BAND_VISIBLE_EXTRA);
                            const visibleEnd = Math.min(RISK_BAND_LEVELS.length - 1, visibleStart + visibleCount - 1);
                            const topHeight = visibleStart * RISK_BAND_ROW_HEIGHT;
                            const bottomHeight = (RISK_BAND_LEVELS.length - 1 - visibleEnd) * RISK_BAND_ROW_HEIGHT;
                            return (
                              <>
                                {topHeight > 0 && (
                                  <tr aria-hidden><td colSpan={2} style={{ height: topHeight, padding: 0, border: 0, lineHeight: 0 }} /></tr>
                                )}
                                {RISK_BAND_LEVELS.slice(visibleStart, visibleEnd + 1).map((r) => {
                                  const priceUsd = getPriceAtRisk(assetId, r);
                                  const isCurrent = r === closestLevel;
                                  return (
                                    <tr
                                      key={r}
                                      className={`border-b border-white/5 ${isCurrent ? "ring-inset ring-1 ring-white/25" : ""}`}
                                      style={{ backgroundColor: getRiskBgRgba(r, 0.2), height: RISK_BAND_ROW_HEIGHT }}
                                    >
                                      <td className="risk-band-cell px-4 py-0 tabular-nums font-medium text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.4)] align-middle text-center" style={{ color: getRiskColor(r), height: RISK_BAND_ROW_HEIGHT }}>{formatRiskValue(r)}</td>
                                      <td className="risk-band-cell px-4 py-0 tabular-nums text-white/95 drop-shadow-[0_1px_1px_rgba(0,0,0,0.4)] align-middle text-center" style={{ height: RISK_BAND_ROW_HEIGHT }}>
                                        {formatPriceByAsset(assetId, priceUsd, currency, USD_TO_AUD)}
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

            {/* Strategy Builder tab — Asset selector first, then Create (wizard) or Edit (full form) */}
            {dashboardTab === "manualPlanner" && (
              <div className="px-6 py-5 md:px-8 md:py-6">
                {builderAsset === null ? (
                  <>
                    <p className="mb-4 text-sm text-white/80">Which asset would you like to build a strategy for?</p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {ASSET_ORDER.map((id) => {
                        const a = allAssets[id];
                        const isStandardAsset = id !== "BTC";
                        const isLockedBuilder = !effectiveIsStandard && isStandardAsset;
                        const logoFailedBuilder = tokenLogoFailed.has(id);
                        return (
                          <button
                            key={id}
                            type="button"
                            onClick={() => { if (isLockedBuilder) { if (planTier === "anonymous") setAuthModal("login"); else setManagePlanOpen(true); } else setBuilderAsset(id); }}
                            disabled={isLockedBuilder}
                            className={`relative flex flex-col items-center gap-2 rounded-xl border px-4 py-5 transition-colors text-left ${
                              isLockedBuilder ? "cursor-not-allowed border-white/15 bg-white/[0.04] opacity-70" : isStandardAsset ? "border-white/15 bg-white/[0.04] opacity-90 hover:opacity-100 hover:bg-white/[0.06]" : "border-white/15 bg-white/[0.06] hover:bg-white/[0.08]"
                            }`}
                          >
                            {!effectiveIsStandard && isStandardAsset && (
                              <span className="absolute top-2 right-2 rounded px-1.5 py-0.5 text-[10px] font-medium bg-[#F28C28]/30 text-[#F28C28]">Standard</span>
                            )}
                            <span className={`relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white overflow-hidden ${ASSET_COLORS[id] ?? "bg-white/20"}`}>
                              {!logoFailedBuilder && TOKEN_LOGOS[id] ? (
                                <img src={TOKEN_LOGOS[id]} alt="" className="h-full w-full object-cover" onError={() => setTokenLogoFailed((s) => new Set(s).add(id))} />
                              ) : null}
                              <span className={logoFailedBuilder || !TOKEN_LOGOS[id] ? "absolute inset-0 flex items-center justify-center" : "sr-only"}>{id}</span>
                            </span>
                            <span className="text-sm font-medium text-white">{a?.name ?? id}</span>
                          </button>
                        );
                      })}
                    </div>
                  </>
                ) : (
                <>
                {editingPlanId ? (() => {
                  const editingPlan = savedPlans.find((p) => p.id === editingPlanId);
                  return editingPlan ? (
                    <>
                      <div className="mb-4 rounded-lg border border-white/15 bg-white/[0.06] px-4 py-2.5 flex items-center justify-between gap-3">
                        <p className="text-sm text-white/90">Editing: <span className="font-medium text-white">{editingPlan.name}</span></p>
                      </div>
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

                    {/* Active Risk Range — all strategy types; static bar + inputs only */}
                    <div className="mt-6 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-4">
                      <p className="text-[11px] font-medium uppercase tracking-wider text-white/60 mb-3">Active Risk Range (Start → End)</p>
                      <p className="mb-3 text-xs text-white/70">Runs only while risk is within <span className="tabular-nums font-medium text-white/90">{activeRiskStart === "" || activeRiskEnd === "" ? "—" : `${builderMinR} → ${builderMaxR}`}</span></p>
                      <div className="grid grid-cols-2 gap-4 mb-3">
                        <div>
                          <label htmlFor="active-risk-start" className="mb-1 block text-[11px] font-medium text-white/60">Start risk</label>
                          <input id="active-risk-start" type="number" min={0} max={100} value={activeRiskStart === "" ? "" : activeRiskStart} onChange={(e) => { const v = e.target.value; setActiveRiskStart(v === "" ? "" : Math.max(0, Math.min(100, Number(v) || 0))); }} placeholder="0–100" className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white tabular-nums placeholder-white/30 focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" />
                        </div>
                        <div>
                          <label htmlFor="active-risk-end" className="mb-1 block text-[11px] font-medium text-white/60">End risk</label>
                          <input id="active-risk-end" type="number" min={0} max={100} value={activeRiskEnd === "" ? "" : activeRiskEnd} onChange={(e) => { const v = e.target.value; setActiveRiskEnd(v === "" ? "" : Math.max(0, Math.min(100, Number(v) || 0))); }} placeholder="0–100" className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white tabular-nums placeholder-white/30 focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" />
                        </div>
                      </div>
                      <div className="relative h-2 w-full rounded-full overflow-hidden" style={{ background: `linear-gradient(to right, ${getRiskColor(0)} 0%, ${getRiskColor(50)} 50%, ${getRiskColor(100)} 100%)` }} aria-hidden>
                        <div className="absolute inset-0 rounded-full bg-black/30" style={{ left: 0, width: `${builderMinR}%` }} />
                        <div className="absolute inset-0 rounded-full bg-black/30" style={{ left: `${builderMaxR}%`, right: 0 }} />
                        <div className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-white/30 shadow-sm" style={{ left: `${startNum}%` }} />
                        <div className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-white/30 shadow-sm" style={{ left: `${endNum}%` }} />
                      </div>
                      <p className="mt-2 text-[10px] text-white/50">
                        {dcaMode === "accumulate" && builderMinR >= builderMaxR && (builderMinR > 0 || builderMaxR < 100) ? "Start risk must be greater than end risk (e.g. 30 → 10)." : null}
                        {dcaMode === "distribute" && builderMaxR <= builderMinR && (builderMinR < 100 || builderMaxR > 0) ? "Start risk must be less than end risk (e.g. 50 → 80)." : null}
                        {!(dcaMode === "accumulate" && builderMinR >= builderMaxR && (builderMinR > 0 || builderMaxR < 100)) && !(dcaMode === "distribute" && builderMaxR <= builderMinR && (builderMinR < 100 || builderMaxR > 0)) ? "Strategy executes only when current risk is within this range. Values 0–100." : null}
                      </p>
                    </div>
                </div>

                <div className={`overflow-hidden transition-all duration-300 ease-out ${hasChosenDcaType && dcaMode ? "max-h-[1200px] opacity-100 mt-2" : "max-h-0 opacity-0"}`}>
                  <div>
                    {/* Risk Context — single bar: current risk + active range; optional level ticks for scaled */}
                    <div className="mb-6">
                      <div className="flex justify-between text-[11px] text-white/60 mb-1.5">
                        <span>Current risk: <span className="tabular-nums font-medium text-white/80">{currentRiskForPlanner}</span></span>
                        <span>Active range: <span className="tabular-nums font-medium text-white/80">{builderMinR} → {builderMaxR}</span></span>
                      </div>
                      <div className="relative h-2.5 w-full rounded-full overflow-visible" style={{ background: `linear-gradient(to right, ${getRiskColor(0)} 0%, ${getRiskColor(50)} 50%, ${getRiskColor(100)} 100%)` }}>
                        <div className="absolute inset-0 rounded-full bg-black/25" style={{ left: 0, width: `${builderMinR}%` }} aria-hidden />
                        <div className="absolute inset-0 rounded-full bg-black/25" style={{ left: `${builderMaxR}%`, right: 0 }} aria-hidden />
                        {strategyType === "dynamic" && (() => {
                          const step = dynamicStepInterval ?? 5;
                          const levels: number[] = dcaMode === "accumulate" ? (() => { const L: number[] = []; for (let r = builderMaxR; r >= builderMinR; r -= step) L.push(r); return L; })() : (() => { const L: number[] = []; for (let r = builderMinR; r <= builderMaxR; r += step) L.push(r); return L; })();
                          return levels.map((r) => (
                            <div key={r} className="absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/40 bg-white/10" style={{ left: `${r}%` }} aria-hidden />
                          ));
                        })()}
                        <div className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white border-2 border-white/90 shadow-sm z-10" style={{ left: `${currentRiskForPlanner}%` }} aria-hidden title={`Current risk ${currentRiskForPlanner}`} />
                      </div>
                    </div>

                    {/* Unified field structure — no threshold inputs; active range is the only gating rule */}
                    {dcaMode === "accumulate" && (
                      <div className="space-y-4">
                        {strategyType === "fixed" && (
                          <div><label htmlFor="frequency-acc" className="mb-1 block text-xs font-medium text-white/70">Buy Frequency</label><select id="frequency-acc" value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]">{FREQUENCY_OPTIONS.map((o) => <option key={o.value} value={o.value} className="bg-[#0a1f35] text-white">{o.label}</option>)}</select></div>
                        )}
                        <div><label htmlFor="invest-per-interval" className="mb-1 block text-xs font-medium text-white/70">Buy Amount</label><input id="invest-per-interval" type="number" min={0} step={50} value={investPerInterval} onChange={(e) => setInvestPerInterval(Number(e.target.value) || 0)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/40 focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" /></div>
                        {strategyType === "dynamic" && (
                          <ScalingRuleBlock side="buy" startingLevel={builderMaxR} interval={dynamicStepInterval} increasePct={dynamicMultiplierPct} onIntervalChange={setDynamicStepInterval} onIncreasePctChange={setDynamicMultiplierPct} />
                        )}
                        <div><label htmlFor="capital" className="mb-1 block text-xs font-medium text-white/70">Total Strategy Budget</label><input id="capital" type="number" min={0} step={100} value={capital} onChange={(e) => setCapital(Number(e.target.value) || 0)} className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/40 focus:border-[#F28C28] focus:outline-none focus:ring-1 focus:ring-[#F28C28]" /></div>
                      </div>
                    )}

                    {dcaMode === "distribute" && (
                      <div className="space-y-4">
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
                          <ScalingRuleBlock side="sell" startingLevel={builderMinR} interval={dynamicStepInterval} increasePct={dynamicMultiplierPct} onIntervalChange={setDynamicStepInterval} onIncreasePctChange={setDynamicMultiplierPct} />
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
                          <p className="mt-2 text-sm text-white/90">{symbol}{(dcaMode === "accumulate" ? investPerInterval : sellPerInterval).toLocaleString()} {dcaMode === "accumulate" ? "per execution" : (strategyType === "fixed" ? "per execution" : "per step")}</p>
                          {strategyType === "fixed" ? (
                            <p className="mt-1 text-sm text-white/80">Runs on {FREQUENCY_OPTIONS.find((o) => o.value === frequency)?.label ?? frequency} while risk remains within the active range.</p>
                          ) : (
                            <p className="mt-1 text-sm text-white/80">Triggers orders as risk reaches each planned level within the active range.</p>
                          )}
                          {dcaMode === "accumulate" && btcPriceForPlanner > 0 && (
                            <p className="mt-2 text-[11px] text-white/50">Est. {builderAsset ?? "BTC"} per buy (at current price): ~{(investPerInterval / btcPriceForPlanner).toFixed(4)} {builderAsset ?? "BTC"}</p>
                          )}
                        </div>
                      </div>
                    ) : (() => {
                      const st = strategyType ?? "fixed";
                      const builderPlan: SavedStrategy = { id: "", name: "", mode: dcaMode, strategyType: st, type: st === "fixed" ? "fixed" : "scaled", side: dcaMode === "accumulate" ? "buy" : "sell", triggerMode: st === "fixed" ? "schedule" : "risk-step", threshold: dcaMode === "accumulate" ? builderMaxR : builderMinR, activeRiskStart: Math.max(0, Math.min(100, startNum)), activeRiskEnd: Math.max(0, Math.min(100, endNum)), frequency, amountPerPurchase: dcaMode === "accumulate" ? investPerInterval : sellPerInterval, capital: dcaMode === "accumulate" ? capital : 0, btcHoldings: dcaMode === "distribute" ? btcHoldings : undefined, alertsEnabled: false, active: false, createdAt: "", status: "Waiting", dynamicStepInterval: (dcaMode === "distribute" || st === "dynamic") ? dynamicStepInterval : 5, dynamicMultiplierPct: st === "dynamic" ? dynamicMultiplierPct : 0 };
                      const levels = getStrategyLevels(builderPlan);
                      if (dcaMode === "distribute") {
                        const totalBtcToDistribute = levels.reduce((sum, L) => {
                          const amtFiat = getAmountAtRisk(builderPlan, L);
                          const priceAtL = getPriceAtRisk(builderAsset ?? "BTC", L);
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
                                      <th className="py-2 pr-3 font-medium text-white/70">Est. {builderAsset ?? "BTC"}</th>
                                      <th className="py-2 font-medium text-white/70">Est. Proceeds ({currency})</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {levels.map((risk) => {
                                      const amtFiat = getAmountAtRisk(builderPlan, risk);
                                      const priceAtRisk = getPriceAtRisk(builderAsset ?? "BTC", risk);
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
                              <p className="mt-0.5 text-sm text-white/90">Total {builderAsset ?? "BTC"} to distribute (max): ~{Math.min(totalBtcToDistribute, btcHoldings).toFixed(4)} {builderAsset ?? "BTC"}</p>
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
                            <p className="mt-0.5 text-[11px] text-white/60">Projected {builderAsset ?? "BTC"} if fully executed: ~{(projectedBtc12Mo > 0 ? projectedBtc12Mo : (amountPerTrigger * triggersAvailable / Math.max(1, btcPriceForPlanner))).toFixed(4)} {builderAsset ?? "BTC"}</p>
                          </div>
                        </div>
                      );
                    })())}

                    <div className="mt-8 flex flex-col sm:flex-row gap-2">
                      {editingPlanId ? (
                        <>
<button type="button" onClick={() => setShowUpdateConfirmModal(true)} className="flex-1 rounded-lg bg-[#F28C28] py-3 text-sm font-medium text-white shadow transition-all duration-200 hover:bg-[#F5A623] hover:scale-105 focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#061826]">
                          Save Changes
                        </button>
                          <button type="button" onClick={() => { setEditingPlanId(null); setStrategyNameInput(""); setDashboardTab("savedPlan"); }} className="flex-1 rounded-lg border border-white/20 py-3 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent focus:outline-none focus:ring-2 focus:ring-white/20 focus:ring-offset-2 focus:ring-offset-[#061826]">
                            Cancel
                          </button>
                        </>
                      ) : effectiveCanSaveAndActivate ? (
                        <button type="button" onClick={() => setShowSaveStrategyModal(true)} className="w-full rounded-lg bg-[#F28C28] py-3 text-sm font-medium text-white shadow transition-all duration-200 hover:bg-[#F5A623] hover:scale-105 focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#061826]">
                          Save Strategy
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            persistDraftFromCurrentState();
                            if (!isLoggedIn) { setAuthModal("register"); return; }
                            if (planTier === "free" && !userState.emailVerified) { setAuthModal("register-verify"); return; }
                            if (planTier === "free" && userState.trialUsed) { setManagePlanOpen(true); return; }
                            setTrialConfirmOpen(true);
                          }}
                          className="w-full rounded-lg bg-[#F28C28] py-3 text-sm font-medium text-white shadow transition-all duration-200 hover:bg-[#F5A623] hover:scale-105 focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#061826]"
                        >
                          {!isLoggedIn ? "Create account to save" : planTier === "free" && !userState.emailVerified ? "Please verify your email to start your free trial" : planTier === "free" && userState.trialUsed ? "Upgrade to Standard to save strategies" : "Start your 7-day free trial to save strategies"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                    </>
                  ) : null;
                })() : (
                  <div className="rounded-xl border border-white/10 bg-white/[0.06] px-6 py-12 text-center">
                    <p className="text-sm text-white/80 mb-2">Build a strategy step by step.</p>
                    <button type="button" onClick={openWizard} className="rounded-lg border border-white/20 px-6 py-3 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#061826]">
                      Create Strategy
                    </button>
                  </div>
                )}
                </>
                ) }
              </div>
            )}

            {/* My Strategies tab — accordion, level-based deployment */}
            {dashboardTab === "savedPlan" && (
              <div className="px-6 py-5 md:px-8 md:py-6 space-y-3">
                {!isLoggedIn ? (
                  <div className="rounded-xl border border-white/10 bg-white/[0.06] px-6 py-14 text-center">
                    <p className="text-base font-semibold text-white">Log in to view your saved strategies</p>
                    <button type="button" onClick={() => setAuthModal("login")} className="mt-6 rounded-lg border border-white/20 px-5 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#0a1f35]">
                      Log in
                    </button>
                  </div>
                ) : savedPlans.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-white/[0.06] px-6 py-14 text-center">
                    <p className="text-base font-semibold text-white">No strategies yet</p>
                    <p className="mt-2 text-sm text-white/60 max-w-sm mx-auto">
                      {effectiveCanSaveAndActivate ? "Create your first strategy with the Strategy Builder." : effectiveStrategiesLocked ? "Upgrade to Standard to save and manage strategies." : "Start your free trial to save strategies."}
                    </p>
                    <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
                      <button
                        type="button"
                        onClick={() => { setDashboardTab("manualPlanner"); setBuilderAsset(null); dashboardSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }}
                        className="rounded-lg border border-white/20 px-5 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#0a1f35]"
                      >
                        Create Strategy
                      </button>
                      {!effectiveCanSaveAndActivate && (
                        <button
                          type="button"
                          onClick={() => { if (planTier === "free" && !userState.trialUsed && userState.emailVerified) setTrialConfirmOpen(true); else if (planTier === "free" && userState.trialUsed) setManagePlanOpen(true); else setAuthModal("register"); }}
                          className="rounded-lg border border-white/20 px-5 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent focus:outline-none focus:ring-2 focus:ring-white/20 focus:ring-offset-2 focus:ring-offset-[#0a1f35]"
                        >
                          {planTier === "free" && !userState.trialUsed ? "Start free trial" : "Upgrade to Standard"}
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="relative">
                    {effectiveStrategiesLocked && (
                      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-xl bg-black/50 backdrop-blur-sm">
                        <p className="text-sm font-medium text-white/90 text-center px-4">Your trial has ended. Upgrade to Standard to access your strategies.</p>
                        <button type="button" onClick={() => setManagePlanOpen(true)} className="mt-4 rounded-lg border border-white/20 px-4 py-2 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#061826]">
                          Upgrade to Standard
                        </button>
                      </div>
                    )}
                  {(() => {
                    const byAsset = new Map<string, SavedStrategy[]>();
                    savedPlans.forEach((p) => {
                      const aid = p.asset_id ?? "BTC";
                      if (!byAsset.has(aid)) byAsset.set(aid, []);
                      byAsset.get(aid)!.push(p);
                    });
                    const assetOrder = ASSET_ORDER.filter((id) => byAsset.has(id));
                    return assetOrder.flatMap((assetId) => {
                      const plans = byAsset.get(assetId)!;
                      return [
                        <div key={`group-${assetId}`} className="space-y-3">
                          {assetId !== assetOrder[0] && <div className="pt-2 border-t border-white/10" />}
                          {plans.map((plan) => {
                    const isAccumulate = plan.mode === "accumulate";
                    const { minR: activeMinR, maxR: activeMaxR } = getActiveRiskBounds(plan);
                    const inActiveRange = riskValue >= activeMinR && riskValue <= activeMaxR;
                    const inZone = inActiveRange;
                    const statusLabel = (inActiveRange && plan.active) ? "ACTIVE" : "WAITING FOR ENTRY";
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
                    const executedByLevel = new Map<number, MockExecution>();
                    (plan.executions ?? []).forEach((ex) => {
                      const closest = levels.reduce((a, b) => Math.abs(a - ex.riskAtExecution) <= Math.abs(b - ex.riskAtExecution) ? a : b);
                      if (!executedByLevel.has(closest)) executedByLevel.set(closest, ex);
                    });
                    const displayCompletedLevels = getDisplayCompletedLevels(plan, levels, executedByLevel);
                    const remainingOrders = levels.filter((L) => !displayCompletedLevels.has(L)).length;
                    const allLevelsExecuted = remainingOrders === 0;
                    const nextPendingLevel = isAccumulate
                      ? levels.filter((L) => L <= riskValue && !displayCompletedLevels.has(L))[0] ?? levels[0]
                      : levels.filter((L) => L >= riskValue && !displayCompletedLevels.has(L))[0] ?? (levels[levels.length - 1] ?? activeMaxR);
                    const planAssetId = plan.asset_id ?? "BTC";
                    const currentBtcPrice = getPriceAtRisk(planAssetId, riskValue);
                    const nextAmount = plan.strategyType === "dynamic" ? getAmountAtRiskFromPlan(plan, nextPendingLevel) : getAmountAtRiskFromPlan(plan, riskValue);
                    const nextBtcPreview = currentBtcPrice > 0 ? nextAmount / currentBtcPrice : 0;
                    const currentValue = totalBtc * currentBtcPrice;
                    const unrealisedPl = totalFiatDeployed > 0 ? currentValue - totalFiatDeployed : 0;
                    const closestLevelToCurrent = levels.reduce((a, b) => Math.abs(a - riskValue) <= Math.abs(b - riskValue) ? a : b);
                    const currentLevelExecuted = displayCompletedLevels.has(closestLevelToCurrent);
                    const totalBtcSold = totalBtc;
                    const btcRemaining = Math.max(0, (plan.btcHoldings ?? 0) - totalBtcSold);
                    const projectedProceedsFiat = levels
                      .filter((L) => !displayCompletedLevels.has(L))
                      .reduce((sum, L) => sum + getAmountAtRiskFromPlan(plan, L), 0);
                    const projectedProceedsAUD = projectedProceedsFiat * USD_TO_AUD;
                    const proceedsRealisedAUD = totalFiatDeployed * USD_TO_AUD;

                    const scenarioPreview = isAccumulate
                      ? levels.slice(0, 3).map((r) => ({ risk: r, amt: getAmountAtRiskFromPlan(plan, r) }))
                      : levels.slice(-3).map((r) => ({ risk: r, amt: getAmountAtRiskFromPlan(plan, r) }));

                    return (
                      <div
                        key={plan.id}
                        ref={plan.id === justSavedId ? savedCardRef : undefined}
                        className={`rounded-xl border border-white/10 bg-white/[0.06] overflow-hidden transition-all duration-200 relative ${effectiveStrategiesLocked ? "opacity-75" : ""} ${isJustSaved ? "saved-card-highlight ring-1 ring-[#F28C28]/20" : ""}`}
                      >
                        {effectiveStrategiesLocked && (
                          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#061826]/80 rounded-xl">
                            <div className="flex flex-col items-center gap-3">
                              <span className="text-2xl text-white/70" aria-hidden>🔒</span>
                              <button type="button" onClick={() => setUpgradeModalOpen(true)} className="rounded-lg border border-white/20 px-4 py-2 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#061826]">
                                Upgrade to Standard
                              </button>
                            </div>
                          </div>
                        )}
                        {/* Accordion header — Strategy Name · Mode · Zone · Status · Current Risk */}
                        <button
                          type="button"
                          onClick={() => !effectiveStrategiesLocked && setExpandedPlanId(isExpanded ? null : plan.id)}
                          className="w-full cursor-pointer px-5 py-4 flex flex-wrap items-center justify-between gap-3 text-left transition-colors duration-150 hover:bg-white/[0.04] focus:outline-none focus-visible:outline-none focus-visible:ring-0 disabled:cursor-default"
                          aria-expanded={isExpanded}
                          disabled={effectiveStrategiesLocked}
                        >
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
                            {(() => {
                              const aid = plan.asset_id ?? "BTC";
                              const planLogoFailed = tokenLogoFailed.has(aid);
                              return (
                                <span className={`relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white overflow-hidden ${ASSET_COLORS[aid] ?? "bg-white/20"}`} title={aid} aria-hidden>
                                  {!planLogoFailed && TOKEN_LOGOS[aid] ? (
                                    <img src={TOKEN_LOGOS[aid]} alt="" className="h-full w-full object-cover" onError={() => setTokenLogoFailed((s) => new Set(s).add(aid))} />
                                  ) : null}
                                  <span className={planLogoFailed || !TOKEN_LOGOS[aid] ? "absolute inset-0 flex items-center justify-center" : "sr-only"}>{aid}</span>
                                </span>
                              );
                            })()}
                            <span className="font-semibold text-white truncate">{plan.name}</span>
                            <span className="text-[11px] text-white/55 shrink-0">{strategyTypeLabel}</span>
                            <span className="shrink-0 text-[11px] text-white/70 tabular-nums">Active range <span style={{ color: getRiskColor(activeMinR) }}>{activeMinR}</span> → <span style={{ color: getRiskColor(activeMaxR) }}>{activeMaxR}</span></span>
                            <span className={`text-[11px] font-medium shrink-0 ${!isAccumulate && btcRemaining <= 0 ? "text-white/60" : (inActiveRange && plan.active) ? "text-emerald-400/90" : "text-[#F28C28]/90"}`}>{!isAccumulate && btcRemaining <= 0 ? `Inactive — No ${planAssetId} remaining` : statusLabel}</span>
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
                                if (!isAccumulate && btcRemaining <= 0) return <NextActionCard header="Status" primaryLine={`Inactive — No ${planAssetId} remaining`} alerts={alertsEl} elevated={false} />;
                                if (!inActiveRange) return <NextActionCard header="Status" primaryLine="WAITING FOR ENTRY" alerts={alertsEl} elevated={false} />;
                                if (allLevelsExecuted) return <NextActionCard header="Status" primaryLine="Strategy fully deployed" alerts={alertsEl} elevated={false} />;
                                if (plan.strategyType === "dynamic") return <NextActionCard header="NEXT ACTION" primaryLine={<span>Risk <span style={{ color: getRiskColor(nextPendingLevel) }}>{nextPendingLevel}</span></span>} secondaryLine={isAccumulate ? <>Buy {sym}{nextAmount.toLocaleString()} → ~{nextBtcPreview.toFixed(4)} {planAssetId}</> : <>Sell ~{nextBtcPreview.toFixed(4)} {planAssetId} → {sym}{nextAmount.toLocaleString()}</>} alerts={alertsEl} elevated />;
                                return <NextActionCard header="NEXT ACTION" primaryLine={<>{getFrequencyLabel(plan.frequency)} — Next in: {formatNextExecutionCountdown(plan.nextExecutionAt)}</>} secondaryLine={isAccumulate ? <>Buy {sym}{plan.amountPerPurchase.toLocaleString()} → ~{(plan.amountPerPurchase / Math.max(1, getPriceAtRisk(planAssetId, riskValue))).toFixed(4)} {planAssetId}</> : <>Sell ~{(plan.amountPerPurchase / Math.max(1, getPriceAtRisk(planAssetId, riskValue))).toFixed(4)} {planAssetId} → {sym}{plan.amountPerPurchase.toLocaleString()}</>} alerts={alertsEl} elevated />;
                              })()}

                              {/* Compact Strategy Progress — horizontal; BUY vs SELL metrics differ */}
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                                {isAccumulate ? (
                                  <>
                                    {plan.strategyType === "fixed" ? (
                                      <>
                                        <div><p className="text-white/50">Capital Deployed</p><p className="tabular-nums font-medium text-white">{sym}{totalFiatDeployed.toLocaleString()}</p></div>
                                        <div><p className="text-white/50">{planAssetId} Accumulated</p><p className="tabular-nums font-medium text-white">{totalBtc.toFixed(4)} {planAssetId}</p></div>
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
                                        <div><p className="text-white/50">{planAssetId} Accumulated</p><p className="tabular-nums font-medium text-white">{totalBtc.toFixed(4)} {planAssetId}</p></div>
                                        <div><p className="text-white/50">Executions</p><p className="tabular-nums font-medium text-white">{displayCompletedLevels.size} / {levels.length}</p></div>
                                        <div><p className="text-white/50">Remaining Orders</p><p className="tabular-nums font-medium text-white">{remainingOrders}</p></div>
                                        <div><p className="text-white/50">Projected {planAssetId} (Full Plan)</p><p className="tabular-nums text-white/90">~{(levels.reduce((sum, L) => sum + getAmountAtRiskFromPlan(plan, L) / Math.max(1, getPriceAtRisk(planAssetId, L)), 0)).toFixed(4)} {planAssetId}</p></div>
                                      </>
                                    )}
                                  </>
                                ) : (
                                  <>
                                    {plan.strategyType === "fixed" ? (
                                      <>
                                        <div><p className="text-white/50">{planAssetId} Distributed</p><p className="tabular-nums font-medium text-white">{totalBtcSold.toFixed(4)} {planAssetId}</p></div>
                                        <div><p className="text-white/50">Cash Realised</p><p className="tabular-nums font-medium text-white">{sym}{Math.round(currency === "AUD" ? proceedsRealisedAUD : totalFiatDeployed).toLocaleString()}</p></div>
                                        <div><p className="text-white/50">Sell Amount</p><p className="tabular-nums font-medium text-white">{sym}{plan.amountPerPurchase.toLocaleString()}</p></div>
                                        {plan.frequency != null && <div><p className="text-white/50">Frequency</p><p className="tabular-nums font-medium text-white">{getFrequencyLabel(plan.frequency)}</p></div>}
                                        <div><p className="text-white/50">Executions</p><p className="tabular-nums font-medium text-white">{executions.length}</p></div>
                                        <div><p className="text-white/50">Remaining {planAssetId} to distribute</p><p className="tabular-nums font-medium text-white">{(plan.btcHoldings ?? 0) <= 0 ? "No cap" : `${btcRemaining.toFixed(4)} ${planAssetId}`}</p></div>
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
                                        <div><p className="text-white/50">{planAssetId} Distributed</p><p className="tabular-nums font-medium text-white">{totalBtcSold.toFixed(4)} {planAssetId}</p></div>
                                        <div><p className="text-white/50">Cash Realised</p><p className="tabular-nums font-medium text-white">{sym}{Math.round(currency === "AUD" ? proceedsRealisedAUD : totalFiatDeployed).toLocaleString()}</p></div>
                                        <div><p className="text-white/50">Executions</p><p className="tabular-nums font-medium text-white">{displayCompletedLevels.size} / {levels.length}</p></div>
                                        <div><p className="text-white/50">Remaining {planAssetId} to Distribute</p><p className="tabular-nums font-medium text-white">{btcRemaining.toFixed(4)} {planAssetId}</p></div>
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
                                      <p className="text-sm text-white/90">{sym}{plan.amountPerPurchase.toLocaleString()} per execution.</p>
                                      {plan.strategyType === "fixed" ? <p className="mt-1 text-[11px] text-white/60">Runs on {getFrequencyLabel(plan.frequency)} while risk remains within the active range.</p> : <p className="mt-1 text-[11px] text-white/60">Triggers orders as risk reaches each planned level within the active range.</p>}
                                      <p className="mt-2 text-[11px] text-white/50">Last buy: {formatLastExecution(plan.lastExecutionAt)}</p>
                                      <p className="mt-0.5 text-[11px] text-white/50">{inZone ? <>Next buy: {formatNextExecutionCountdown(plan.nextExecutionAt)}</> : "WAITING FOR ENTRY"}</p>
                                      <p className="mt-0.5 text-[11px] text-white/50">Cycle started: {formatLastExecution(plan.activatedAt ?? plan.strategyStartDate)}</p>
                                    </>
                                  ) : (
                                    <>
                                      <p className="text-sm text-white/90">{sym}{plan.amountPerPurchase.toLocaleString()} per execution.</p>
                                      {plan.strategyType === "fixed" ? <p className="mt-1 text-[11px] text-white/60">Runs on {getFrequencyLabel(plan.frequency)} while risk remains within the active range.</p> : <p className="mt-1 text-[11px] text-white/60">Triggers orders as risk reaches each planned level within the active range.</p>}
                                      <p className="mt-1 text-[11px] text-white/50">Stops automatically if available BTC reaches 0</p>
                                      <p className="mt-2 text-[11px] text-white/50">Last sell: {formatLastExecution(plan.lastExecutionAt)}</p>
                                      <p className="mt-0.5 text-[11px] text-white/50">{inZone ? <>Next sell: {formatNextExecutionCountdown(plan.nextExecutionAt)}</> : "WAITING FOR ENTRY"}</p>
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
                                              <th className="px-3 py-2 font-medium text-white/70">Est. {planAssetId}</th>
                                            </>
                                          ) : (
                                            <>
                                              <th className="px-3 py-2 font-medium text-white/70">{planAssetId} Sold</th>
                                              <th className="px-3 py-2 font-medium text-white/70">Est. Proceeds ({currency})</th>
                                            </>
                                          )}
                                          <th className="px-3 py-2 font-medium text-white/70">Status</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {levels.map((level) => {
                                          const amtFiat = getAmountAtRiskFromPlan(plan, level);
                                          const priceAtLevel = getPriceAtRisk(planAssetId, level);
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
                                              <td className="px-3 py-2 tabular-nums" style={{ color: getRiskColor(level) }}>{level}</td>
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
                                        isAccumulate ? `Order size: ${sym}${orderSize.toLocaleString()}` : `Order size: ~${(orderSize / Math.max(1, getPriceAtRisk(planAssetId, level))).toFixed(4)} ${planAssetId}`,
                                        executed ? "Status: Filled" : isNext ? "Status: Current" : "Status: Pending",
                                        ...(ex?.date ? [`Executed: ${formatLastExecution(ex.date + "T00:00:00.000Z")}`] : []),
                                      ];
                                      return (
                                        <div key={level} className={`absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full flex items-center justify-center ${markerClass}`} style={{ left: `${level}%` }} aria-hidden title={tooltipLines.join("\n")}>
                                          {executed ? <span className="risk-marker-tick text-[9px] font-bold leading-none">✓</span> : null}
                                        </div>
                                      );
                                    })}
                                    <div className="absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-sm z-[11]" style={{ left: `${riskValue}%` }} aria-hidden title={`Current risk ${riskValue}`} />
                                  </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-3 shrink-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-white/60">{plan.active ? "Active" : "Paused"}</span>
                                    <button type="button" role="switch" aria-checked={plan.active} disabled={!effectiveCanSaveAndActivate} onClick={(e) => { e.stopPropagation(); if (effectiveCanSaveAndActivate) setPlanActive(plan.id, !plan.active); }} title={!effectiveCanSaveAndActivate ? "Start free trial to activate" : undefined} className={`relative h-5 w-9 shrink-0 rounded-full border transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed ${plan.active ? "border-emerald-500/40 bg-emerald-500/20" : "border-[#F28C28]/40 bg-[#F28C28]/20"}`}>
                                      <span className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150 ${plan.active ? "translate-x-4" : "translate-x-0"}`} />
                                    </button>
                                  </div>
                                  {!effectiveStrategiesLocked && (
                                    <>
                                      <button type="button" onClick={(e) => { e.stopPropagation(); loadPlanForEdit(plan); }} className="rounded-lg border border-white/20 px-3 py-1.5 text-xs font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent">Edit</button>
                                      <button type="button" onClick={(e) => { e.stopPropagation(); setDeleteConfirmPlanId(plan.id); }} className="rounded-lg border border-red-400/60 px-3 py-1.5 text-xs font-medium text-red-300 transition-all duration-200 hover:bg-red-500/25 hover:border-red-400">Delete</button>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                          })}
                        </div>
                      ];
                    });
                  })()
                }
                  </div>
                )}
              </div>
            )}

            {false && (
              <div className="flex flex-col items-center justify-center px-6 py-16 text-center md:px-8 hidden">
                {!canAccessSimulatorPro ? (
                  <>
                    <span className="mb-3 text-3xl text-white/40" aria-hidden>🔒</span>
                    <p className="text-sm font-medium text-white/80">Simulator (Pro)</p>
                    <p className="mt-2 text-xs text-white/55 max-w-sm">Start your free 7-day trial to unlock historical simulation and advanced strategy testing.</p>
                    <button type="button" onClick={() => setAuthModal("register")} className="mt-5 rounded-lg border border-white/20 px-5 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:bg-[#F28C28] hover:border-transparent focus:outline-none focus:ring-2 focus:ring-[#F28C28] focus:ring-offset-2 focus:ring-offset-[#061826]">
                      Upgrade to Standard
                    </button>
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

      {/* Strategy help tooltips — portaled to body to avoid clipping */}
      {typeof document !== "undefined" &&
        strategyHelpOpen &&
        tooltipAnchor != null &&
        (() => {
          const anchor = tooltipAnchor;
          return createPortal(
            <div
              key={`strategy-tooltip-${dcaMode ?? "accumulate"}-${strategyHelpOpen}`}
              ref={strategyTooltipRef}
              className="strategy-help-tooltip strategy-help-tooltip-portal"
              role="tooltip"
              onMouseLeave={() => setStrategyHelpOpen(null)}
              style={{
                position: "fixed",
                left: anchor.left + anchor.width / 2,
                top: tooltipPlacement === "above" ? anchor.top - 8 : anchor.top + anchor.height + 8,
                transform: `translate(-50%, ${tooltipPlacement === "above" ? "-100%" : "0"})`,
                zIndex: 9999,
              }}
            >
            <div className="strategy-help-tooltip-inner">
            {strategyHelpOpen === "fixed" && (dcaMode === "distribute" ? (
              <>
                <p className="text-xs font-semibold text-white/95 leading-snug">User-defined strategy: sells a fixed amount (in cash) at each step level in your defined range.</p>
                <p className="mt-2 text-[11px] text-white/70 leading-snug">Planned execution based on your defined rules. Example: sell $5,000 at each risk level within the active range (e.g. 50, 55, 60…).</p>
              </>
            ) : (
              <>
                <p className="text-xs font-semibold text-white/95 leading-snug">User-defined strategy: buys a fixed amount at your chosen frequency while risk remains within your defined range.</p>
                <p className="mt-2 text-[11px] text-white/70 leading-snug">Planned execution based on your defined rules. Example: buy $1,000 weekly while risk remains within the active range.</p>
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
                <p className="mt-2 text-[11px] text-white/70 leading-snug">Planned execution based on your defined rules. Triggers at each planned level within the active range; order size increases by your chosen % per level.</p>
              </>
            ))}
            </div>
          </div>,
          document.body
        );
        })()}

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
