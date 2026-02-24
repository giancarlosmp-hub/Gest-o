export type WalletStatus = {
  label: string;
  value: number;
  color: string;
};

export type AbcSegment = {
  label: "A" | "B" | "C";
  value: number;
  color: string;
};

export type PortfolioDashboardMock = {
  walletStatus: WalletStatus[];
  abcCurve: AbcSegment[];
  positivation: {
    positiveCustomers: number;
    totalCustomers: number;
  };
  monthlySalesGoal: {
    labels: string[];
    achieved: number[];
    goal: number[];
  };
};

export const portfolioDashboardMock: PortfolioDashboardMock = {
  walletStatus: [
    { label: "Ativos", value: 124, color: "#2563eb" },
    { label: "Inativos recentes", value: 28, color: "#f59e0b" },
    { label: "Inativos antigos", value: 17, color: "#ef4444" },
    { label: "Prospects", value: 52, color: "#10b981" },
  ],
  abcCurve: [
    { label: "A", value: 61, color: "#2563eb" },
    { label: "B", value: 27, color: "#0ea5e9" },
    { label: "C", value: 12, color: "#93c5fd" },
  ],
  positivation: {
    positiveCustomers: 167,
    totalCustomers: 221,
  },
  monthlySalesGoal: {
    labels: ["Sem 1", "Sem 2", "Sem 3", "Sem 4"],
    achieved: [154000, 311500, 472800, 622400],
    goal: [160000, 320000, 480000, 640000],
  },
};

