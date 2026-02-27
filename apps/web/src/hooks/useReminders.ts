import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext";
import api from "../lib/apiClient";

export type ReminderState = {
  hasOverdueFollowUp: boolean;
  upcomingMeetingsCount: number;
  sellerWithoutActivityToday: boolean;
  tasksDueCount: number;
  followUpsDueCount: number;
  overdueOppsCount: number;
  agendaBadgeCount: number;
  activitiesBadgeCount: number;
};

type Activity = {
  id: string;
  dueDate?: string;
  done: boolean;
};

type Opportunity = {
  id: string;
  followUpDate?: string;
  expectedCloseDate?: string;
  stage?: string;
};

type ReminderMode = "todayAndOverdue" | "overdueOnly";

type UseRemindersOptions = {
  autoLoad?: boolean;
  mode?: ReminderMode;
};

const CLOSED_OPPORTUNITY_STAGES = new Set(["ganho", "perdido"]);

const initialReminders: ReminderState = {
  hasOverdueFollowUp: false,
  upcomingMeetingsCount: 0,
  sellerWithoutActivityToday: false,
  tasksDueCount: 0,
  followUpsDueCount: 0,
  overdueOppsCount: 0,
  agendaBadgeCount: 0,
  activitiesBadgeCount: 0,
};

const REMINDERS_CACHE_TTL_MS = 60_000;

type CacheEntry = {
  dayKey: string;
  expiresAt: number;
  reminders: ReminderState;
};

const remindersCache = new Map<string, CacheEntry>();

function isDevelopment() {
  return import.meta.env.DEV;
}

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "CanceledError");
}

function getCurrentMonthParam(referenceDate = new Date()) {
  const year = referenceDate.getFullYear();
  const month = String(referenceDate.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function getDayKey(referenceDate = new Date()) {
  const year = referenceDate.getFullYear();
  const month = String(referenceDate.getMonth() + 1).padStart(2, "0");
  const day = String(referenceDate.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getCacheKey(userId?: string) {
  return userId ? `user:${userId}` : "anonymous";
}

function getCachedReminders(cacheKey: string, now = Date.now(), dayKey = getDayKey()) {
  const cached = remindersCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= now || cached.dayKey !== dayKey) {
    remindersCache.delete(cacheKey);
    return null;
  }
  return cached.reminders;
}

function cacheReminders(cacheKey: string, reminders: ReminderState, now = Date.now(), dayKey = getDayKey()) {
  remindersCache.set(cacheKey, {
    reminders,
    dayKey,
    expiresAt: now + REMINDERS_CACHE_TTL_MS,
  });
}

function clearRemindersCacheForKey(cacheKey: string) {
  remindersCache.delete(cacheKey);
}

function parseDate(value?: string) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export function startOfTodayLocal(referenceDate = new Date()) {
  const start = new Date(referenceDate);
  start.setHours(0, 0, 0, 0);
  return start;
}

export function endOfTodayLocal(referenceDate = new Date()) {
  const end = new Date(startOfTodayLocal(referenceDate));
  end.setHours(23, 59, 59, 999);
  return end;
}

function resolveReminderOptions(optionsOrAutoLoad?: boolean | UseRemindersOptions) {
  if (typeof optionsOrAutoLoad === "boolean") {
    return { autoLoad: optionsOrAutoLoad, mode: "todayAndOverdue" as ReminderMode };
  }

  return {
    autoLoad: optionsOrAutoLoad?.autoLoad ?? true,
    mode: optionsOrAutoLoad?.mode ?? "todayAndOverdue",
  };
}

export function useReminders(optionsOrAutoLoad?: boolean | UseRemindersOptions) {
  const { autoLoad, mode } = resolveReminderOptions(optionsOrAutoLoad);
  const { user } = useAuth();

  const [loading, setLoading] = useState(false);
  const [reminders, setReminders] = useState<ReminderState>(initialReminders);

  const cacheKey = getCacheKey(user?.id);

  const checkReminders = useCallback(
    async (signal?: AbortSignal, force = false) => {
      const dayKey = getDayKey();
      const now = Date.now();

      if (!force) {
        const cached = getCachedReminders(cacheKey, now, dayKey);
        if (cached) {
          setReminders(cached);
          setLoading(false);
          return;
        }
      }

      setLoading(true);

      try {
        const month = getCurrentMonthParam();
        const todayEnd = endOfTodayLocal();
        const todayStart = startOfTodayLocal();

        const isInSelectedWindow = (date: Date) => {
          if (mode === "overdueOnly") {
            return date < todayStart;
          }
          return date <= todayEnd;
        };

        const [activitiesResponse, opportunitiesResponse] = await Promise.all([
          api.get(`/activities?month=${month}`, { signal }),
          api.get("/opportunities?status=open", { signal }),
        ]);

        const activities = Array.isArray(activitiesResponse.data) ? (activitiesResponse.data as Activity[]) : [];

        const opportunitiesPayload = Array.isArray(opportunitiesResponse.data?.items)
          ? opportunitiesResponse.data.items
          : opportunitiesResponse.data;
        const opportunities = Array.isArray(opportunitiesPayload) ? (opportunitiesPayload as Opportunity[]) : [];

        const tasksDueCount = activities.filter((item) => {
          if (item.done) return false;
          const dueDate = parseDate(item.dueDate);
          return Boolean(dueDate && isInSelectedWindow(dueDate));
        }).length;

        const followUpsDueCount = opportunities.filter((item) => {
          if (CLOSED_OPPORTUNITY_STAGES.has(item.stage ?? "")) return false;
          const followUpDate = parseDate(item.followUpDate);
          return Boolean(followUpDate && isInSelectedWindow(followUpDate));
        }).length;

        const overdueOppsCount = opportunities.filter((item) => {
          if (CLOSED_OPPORTUNITY_STAGES.has(item.stage ?? "")) return false;
          const expectedCloseDate = parseDate(item.expectedCloseDate);
          return Boolean(expectedCloseDate && expectedCloseDate < todayStart);
        }).length;

        const agendaBadgeCount = tasksDueCount + followUpsDueCount + overdueOppsCount;

        const nextReminders: ReminderState = {
          hasOverdueFollowUp: false,
          upcomingMeetingsCount: 0,
          sellerWithoutActivityToday: false,
          tasksDueCount,
          followUpsDueCount,
          overdueOppsCount,
          activitiesBadgeCount: tasksDueCount,
          agendaBadgeCount,
        };

        if (!signal?.aborted) {
          cacheReminders(cacheKey, nextReminders, now, dayKey);
          setReminders(nextReminders);
        }
      } catch (error) {
        if (!isAbortError(error) && isDevelopment()) {
          console.error("[useReminders] Falha ao calcular lembretes", error);
        }

        if (!signal?.aborted) {
          clearRemindersCacheForKey(cacheKey);
          setReminders(initialReminders);
        }
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [cacheKey, mode],
  );

  useEffect(() => {
    if (!autoLoad) return;

    const controller = new AbortController();
    void checkReminders(controller.signal);

    return () => {
      controller.abort();
      setLoading(false);
    };
  }, [autoLoad, checkReminders]);

  useEffect(() => {
    if (!autoLoad) return;

    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0);
    const msUntilNextMidnight = Math.max(nextMidnight.getTime() - now.getTime(), 0);

    const timeoutId = window.setTimeout(() => {
      clearRemindersCacheForKey(cacheKey);
      void checkReminders(undefined, true);
    }, msUntilNextMidnight + 1000);

    return () => window.clearTimeout(timeoutId);
  }, [autoLoad, cacheKey, checkReminders]);

  const alerts = useMemo(
    () => ({
      showOverdueFollowUpAlert: reminders.hasOverdueFollowUp,
      showUpcomingMeetingBanner: reminders.upcomingMeetingsCount > 0,
      showNoActivitiesWarning: reminders.sellerWithoutActivityToday,
    }),
    [reminders],
  );

  return {
    reminders,
    loading,
    alerts,
    refreshReminders: (signal?: AbortSignal) => checkReminders(signal, true),
  };
}
