import { Suspense } from "react";
import { VinculosClient } from "./_client";

export const metadata = { title: "Vínculos — Admin Plataforma" };

/**
 * VÍNCULOS — quais empresas cada conta acessa, e com que papel.
 *
 * O dono da instalação escolhe uma conta e marca as empresas numa lista (uma,
 * algumas ou todas). O vínculo é direto, sem convite: a conta já existe. A
 * Equipe de cada empresa continua sendo a porta do admin DAQUELA empresa; esta
 * tela é a visão de cima, que cruza todas.
 *
 * `Suspense` porque a conta escolhida mora em `?usuario=` (`useSearchParams`).
 */
export default function AdminVinculosPage() {
  return (
    <Suspense>
      <VinculosClient />
    </Suspense>
  );
}
