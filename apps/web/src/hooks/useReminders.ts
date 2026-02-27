import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../lib/apiClient";

export type ReminderState = {
  hasOverdueFollowUp: boolean;
  upcomingMeetingsCount: number;
  sellerWithoutActivityToday: boolean;
  agendaBadgeCount: number;
  activitiesBadgeCount: number;
};

type Activity = {
  id: string;
  dueDate: string;
  done: boolean;
};

type Opportunity = {
  id: string;
  followUpDate: string;
};

const initialReminders: ReminderState = {
  hasOverdueFollowUp: false,
  upcomingMeetingsCount: 0,
  sellerWithoutActivityToday: false,
  agendaBadgeCount: 0,
  activitiesBadgeCount: 0,
};

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

export function useReminders(autoLoad = true) {
  const [loading, setLoading] = useState(false);
  const [reminders, setReminders] = useState<ReminderState>(initialReminders);

  const checkReminders = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);

    try {
      const month = getCurrentMonthParam();
      const todayEnd = endOfTodayLocal();

      const [activitiesResponse, opportunitiesResponse] = await Promise.all([
        api.get(`/activities?month=${month}`, { signal }),
        api.get("/opportunities?status=open", { signal }),
      ]);

      const activities = Array.isArray(activitiesResponse.data) ? (activitiesResponse.data as Activity[]) : [];

      const opportunitiesPayload = Array.isArray(opportunitiesResponse.data?.items)
        ? opportunitiesResponse.data.items
        : opportunitiesResponse.data;
      const opportunities = Array.isArray(opportunitiesPayload) ? (opportunitiesPayload as Opportunity[]) : [];

      const activitiesBadgeCount = activities.filter((item) => {
        if (item.done) return false;
        const dueDate = parseDate(item.dueDate);
        return Boolean(dueDate && dueDate <= todayEnd);
      }).length;

      const opportunitiesDueCount = opportunities.filter((item) => {
        const followUpDate = parseDate(item.followUpDate);
        return Boolean(followUpDate && followUpDate <= todayEnd);
      }).length;

      if (!signal?.aborted) {
        setReminders({
          hasOverdueFollowUp: false,
          upcomingMeetingsCount: 0,
          sellerWithoutActivityToday: false,
          activitiesBadgeCount,
          agendaBadgeCount: activitiesBadgeCount + opportunitiesDueCount,
        });
      }
    } catch (error) {
      if (!isAbortError(error) && isDevelopment()) {
        console.error("[useReminders] Falha ao calcular lembretes", error);
      }

      if (!signal?.aborted) {
        setReminders(initialReminders);
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!autoLoad) return;

    const controller = new AbortController();
    void checkReminders(controller.signal);

    return () => {
      controller.abort();
      setLoading(false);
    };
  }, [autoLoad, checkReminders]);

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
    refreshReminders: checkReminders,
  };
}
