# ADR 001 — Identidade de estabelecimento de parceiros UltraFV3

- **Status:** aceito
- **Data:** 30/07/2026

## Contexto

Código ERP, CPF/CNPJ completo e identidade textual podem apontar para registros CRM existentes. O fallback histórico por razão social, cidade e UF fez duas filiais da mesma pessoa jurídica — parceiros 5050 e 4484 — colidirem, apesar de possuírem códigos e CNPJs completos distintos. Além de sobrescrever código/documento, a seleção podia alimentar o merge destrutivo de relacionamentos.

## Decisão

A identidade de estabelecimento obedecerá à seguinte ordem e aos seguintes limites:

1. código ERP exato é a primeira chave, mas não autoriza sobrescrever documento completo divergente;
2. CPF/CNPJ completo normalizado exato é chave forte e pode reconciliar mudança de código;
3. razão social normalizada+cidade normalizada+UF só pode casar payload sem documento válido com um único candidato também sem documento válido e sem código conflitante;
4. documentos completos válidos diferentes representam estabelecimentos distintos; não podem atualizar nem participar do mesmo merge;
5. conflito ou ambiguidade deve produzir diagnóstico sanitizado, nunca expor documento completo nem executar merge automático.

A comparação usa o CPF/CNPJ completo validado (11 ou 14 dígitos), nunca apenas a raiz do CNPJ.

## Alternativas rejeitadas

- **Manter nome+cidade+UF como fallback geral:** preservaria compatibilidade, mas continuaria unindo filiais legítimas.
- **Usar raiz do CNPJ:** identifica grupo empresarial, não estabelecimento, e reproduz o risco.
- **Desativar todo fallback textual:** impediria reconciliar cadastros legados legítimos sem documento.
- **Criar sempre quando o código divergir:** duplicaria registros quando o documento completo é exatamente o mesmo.

## Consequências

- Filiais com documentos distintos tornam-se clientes independentes.
- Registros legados sem documento preservam fallback estritamente inequívoco.
- Mudança legítima de código com documento exato não cria duplicata.
- Código exato com documento conflitante fica bloqueado para saneamento humano, pois criar outro cliente com o mesmo código pode violar unicidade.
- Dados já corrompidos não são reparados automaticamente.

A implementação e a evidência do incidente estão na [investigação 5050×4484](../investigations/ultrafv3-partner-identity-5050-4484.md).
