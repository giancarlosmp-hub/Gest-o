import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../lib/apiClient";
import { useAuth } from "../context/AuthContext";

type Activity = {
  id: string;
  type: string;
  dueDate: string;
  done: boolean;
  ownerSellerId?: string;
};

type Opportunity = {
  id: string;
  followUpDate: string;
};

type ReminderState = {
  hasOverdueFollowUp: boolean;
  upcomingMeetingsCount: number;
  sellerWithoutActivityToday: boolean;
  agendaBadgeCount: number;
  activitiesBadgeCount: number;
};

const initialReminders: ReminderState = {
  hasOverdueFollowUp: false,
  upcomingMeetingsCount: 0,
  sellerWithoutActivityToday: false,
  agendaBadgeCount: 0,
  activitiesBadgeCount: 0,
};

export function useReminders(autoLoad = true) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [reminders, setReminders] = useState<ReminderState>(initialReminders);

  const checkReminders = useCallback(async () => {
    setLoading(true);
    try {
      const [activitiesResponse, opportunitiesResponse] = await Promise.all([
        api.get("/activities"),
        api.get("/opportunities?status=open"),
      ]);

      const activities = Array.isArray(activitiesResponse.data) ? (activitiesResponse.data as Activity[]) : [];
      const opportunitiesPayload = Array.isArray(opportunitiesResponse.data?.items)
        ? opportunitiesResponse.data.items
        : opportunitiesResponse.data;
      const opportunities = Array.isArray(opportunitiesPayload) ? (opportunitiesPayload as Opportunity[]) : [];

      const now = new Date();
      const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const endOfToday = new Date(startOfToday);
      endOfToday.setDate(endOfToday.getDate() + 1);

      const hasOverdueFollowUp = opportunities.some((item) => new Date(item.followUpDate) < now);

      const upcomingMeetingsCount = activities.filter((item) => {
        if (item.type !== "reuniao" || item.done) return false;
        const dueDate = new Date(item.dueDate);
        return dueDate >= now && dueDate <= twoHoursFromNow;
      }).length;

      const sellerActivitiesToday = activities.filter((item) => {
        if (!item.ownerSellerId || !user?.id) return false;
        if (item.ownerSellerId !== user.id) return false;
        const dueDate = new Date(item.dueDate);
        return dueDate >= startOfToday && dueDate < endOfToday;
      }).length;

      const sellerWithoutActivityToday = user?.role === "vendedor" && sellerActivitiesToday === 0;

      setReminders({
        hasOverdueFollowUp,
        upcomingMeetingsCount,
        sellerWithoutActivityToday,
        agendaBadgeCount: upcomingMeetingsCount,
        activitiesBadgeCount: sellerWithoutActivityToday ? 1 : 0,
      });
    } catch {
      setReminders(initialReminders);
    } finally {
      setLoading(false);
    }
  }, [user?.id, user?.role]);

  useEffect(() => {
    if (!autoLoad) return;
    void checkReminders();
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
    loading,
    reminders,
    alerts,
    refreshReminders: checkReminders,
  };
}
