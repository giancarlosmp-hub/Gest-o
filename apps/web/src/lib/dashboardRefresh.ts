export const DASHBOARD_REFRESH_EVENT = "dashboard:refresh";

export type DashboardRefreshDetail = {
  month?: string;
};

export const triggerDashboardRefresh = (detail?: DashboardRefreshDetail) => {
  window.dispatchEvent(new CustomEvent<DashboardRefreshDetail>(DASHBOARD_REFRESH_EVENT, { detail }));
};
