export type CultureKgHa = {
  id: string;
  name: string;
  group: string;
  kgHaMin: number | null;
  kgHaMax: number | null;
  notes?: string;
  active: boolean;
};

export const culturesKgHa: CultureKgHa[] = [
  { id: "soja", name: "Soja", group: "Grãos", kgHaMin: 45, kgHaMax: 65, notes: "Ajustar conforme PMS, vigor e espaçamento.", active: true },
  { id: "milho", name: "Milho", group: "Grãos", kgHaMin: 18, kgHaMax: 28, notes: "Faixa de referência para híbridos comerciais.", active: true },
  { id: "sorgo", name: "Sorgo", group: "Grãos", kgHaMin: 10, kgHaMax: 18, notes: "Pode variar por finalidade: grão, silagem ou cobertura.", active: true },
  { id: "braquiaria", name: "Braquiária", group: "Forrageiras", kgHaMin: 6, kgHaMax: 12, notes: "Considerar VC (valor cultural) e forma de semeadura.", active: true },
  { id: "panicum", name: "Panicum", group: "Forrageiras", kgHaMin: 4, kgHaMax: 8, notes: "Sementes pequenas exigem regulagem fina da distribuição.", active: true },
  { id: "crotalaria", name: "Crotalária", group: "Cobertura", kgHaMin: 12, kgHaMax: 20, notes: "Boa opção para cobertura e aporte de biomassa.", active: true },
  { id: "nabo-forrageiro", name: "Nabo forrageiro", group: "Cobertura", kgHaMin: 8, kgHaMax: 14, notes: "Dose depende do arranjo e do mix de cobertura.", active: true },
  { id: "aveia-preta", name: "Aveia preta", group: "Cobertura", kgHaMin: 40, kgHaMax: 60, notes: "Pode exigir ajuste em semeadura a lanço.", active: true },
];
