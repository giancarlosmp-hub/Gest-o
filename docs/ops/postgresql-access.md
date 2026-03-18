# Acesso administrativo ao PostgreSQL (Gest-o)

O PostgreSQL do Gest-o **não deve ficar exposto publicamente** na internet.

No `docker-compose.yml`, a API já acessa o banco internamente pelo host `db:5432` na rede do Docker, então o funcionamento normal do CRM via navegador/API **não depende** de publicar a porta `5432` no host.

## Diretriz operacional

- não publicar `5432:5432` em produção;
- manter o acesso de aplicação apenas pela rede interna do Docker;
- usar acesso administrativo somente quando necessário e de forma controlada.

## Formas recomendadas de acesso administrativo

### 1) Acesso direto dentro do container

Use o cliente `psql` já disponível no serviço `db`:

```bash
docker compose exec db psql -U postgres -d salesforce_pro
```

Para comandos não interativos:

```bash
docker compose exec -T db psql -U postgres -d salesforce_pro -c "\\dt"
```

### 2) Túnel SSH

Se for realmente necessário acessar o banco a partir da sua máquina, prefira criar um túnel SSH temporário até o servidor e conectar por ele, em vez de expor a porta publicamente.

Exemplo:

```bash
ssh -L 5432:127.0.0.1:5432 usuario@seu-servidor
```

> Observação: para esse fluxo funcionar, o serviço PostgreSQL precisa estar acessível apenas no contexto controlado do servidor/túnel, nunca aberto para toda a internet.

## O que não fazer

- não expor a porta `5432` publicamente só para administração rotineira;
- não usar essa mudança para recriar banco, remover volume ou alterar migrations;
- não executar `docker compose down -v` em produção.
