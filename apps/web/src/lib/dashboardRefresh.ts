export const DASHBOARD_REFRESH_EVENT = "dashboard:refresh";

export const triggerDashboardRefresh = () => {
  window.dispatchEvent(new CustomEvent(DASHBOARD_REFRESH_EVENT));
};
