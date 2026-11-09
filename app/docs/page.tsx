/**
 * /docs — atalho para a documentação da API, que mora em /app/docs (dentro do
 * CRM, com o menu e o login de sempre). O proxy já exige sessão aqui também:
 * `/docs` não está em `PUBLIC_PATHS`.
 */
import { redirect } from "next/navigation";

export default function AtalhoDaDocumentacao(): never {
  redirect("/app/docs");
}
