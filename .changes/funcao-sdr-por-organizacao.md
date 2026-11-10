---
impacto: capacidade_nova
secao: adicionado
titulo: Função SDR por empresa, ligada pelo administrador, com permissões calculadas pela API
---

Cada empresa pode agora ligar a **função SDR** e marcar quais membros da equipe
fazem pré-venda. A função vem **desligada**: quem não a ligar não vê mudança
nenhuma.

SDR não é um papel novo. Ele se soma ao papel que a pessoa já tem: um Atendente,
um Gerente ou um Administrador pode ser SDR, e um Visualizador não pode. A marca
só vale com a função ligada, o membro ativo e papel de Atendente ou acima. Se a
função for desligada, se a pessoa for rebaixada a Visualizador ou se o acesso dela
for revogado, ela perde as permissões de SDR na hora, sem que ninguém precise
desmarcá-la. Religar a função devolve a equipe como estava.

Por enquanto isso existe **só pela API** (`/api/v1/settings/sdr`,
`/api/v1/sdr/assignments` e `/api/v1/sdr/permissions`, com a sessão de quem está
logado), e nenhuma tela ainda usa as permissões de SDR para mostrar ou esconder
algo. Toda mudança fica registrada na auditoria. A atualização acrescenta uma
coluna ao banco e não pede nada a quem opera a VPS.
