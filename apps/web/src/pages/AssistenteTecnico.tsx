import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  CULTURE_FALLBACKS,
  type TechnicalCulture,
  fetchTechnicalCultures,
} from "../lib/technicalCultures";
import { getApiErrorMessage } from "../lib/apiError";
import { useAuth } from "../context/AuthContext";
import SeedingRecommendation from "../components/technical/SeedingRecommendation";

export default function AssistenteTecnico() {
  const { user } = useAuth();
  const canConfigureCatalog = user?.role === "diretor" || user?.role === "gerente";

  const [cultures, setCultures] = useState<TechnicalCulture[]>([]);
  const [loading, setLoading] = useState(true);
  const [fallbackMessage, setFallbackMessage] = useState("");

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      try {
        const data = await fetchTechnicalCultures();
        if (!mounted) return;
        setCultures((data ?? []).filter((item) => item.isActive));
      } catch (error) {
        console.error("Falha ao carregar catálogo técnico", {
          reason: getApiErrorMessage(error, "Erro ao carregar catálogo técnico."),
          error,
        });
        if (!mounted) return;

        setCultures(CULTURE_FALLBACKS);
        setFallbackMessage(
          "Não foi possível carregar as culturas agora. Mostrando uma lista reduzida; recarregue a página para tentar de novo."
        );
        toast.warning("Sem conexão com o servidor: lista reduzida de culturas.");
      } finally {
        if (mounted) setLoading(false);
      }
    };

    load();
    return () => {
      mounted = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="p-6 text-sm text-slate-600">
        Carregando Assistente Técnico...
      </div>
    );
  }

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-slate-900">
          Assistente Técnico
        </h1>
        <p className="text-sm text-slate-600">
          Ferramentas para apoio técnico e regulagem de plantio.
        </p>
      </header>

      <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
        Os resultados são estimativas de apoio e não substituem a recomendação de um engenheiro agrônomo.
      </p>

      {fallbackMessage ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {fallbackMessage}
        </p>
      ) : null}

      <SeedingRecommendation
        cultures={cultures}
        offline={Boolean(fallbackMessage)}
        canConfigureCatalog={canConfigureCatalog}
      />
    </section>
  );
}
