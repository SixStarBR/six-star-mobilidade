# Six Star Mobilidade — Vértice

Aplicação responsiva para a central e para motoristas, com login único por celular e senha. O perfil atribuído pela administração decide quais telas e dados cada conta acessa. O pacote contém o app web/PWA, migrações Supabase e a função protegida de cadastro de usuários; não está conectado nem publicado em contas reais.

## Recursos incluídos

- Acesso comum de administrador e motorista por celular e senha; o celular é convertido para `número@sixstar.mobi`, e a permissão vem do perfil registrado no backend.
- Formulário da corrida com código, passageiro, origem/destino e links, data/horário, motorista/veículo, observações e status.
- Status: agendada, em andamento, concluída, no show e cancelada.
- Cadastro administrativo de motoristas e administradores por celular, senha inicial e papel. Somente um responsável inicial (owner) pode criar outro administrador.
- Isolamento por organização via Supabase RLS e transmissão da posição GPS atual do motorista autenticado para a central.
- PWA responsiva para instalação pelo navegador em Android e iPhone, quando hospedada em HTTPS.

## Requisitos ainda não provisionados

A operação informou que ainda não possui projeto Supabase, Google Maps ou domínio. Antes de usar dados reais, será necessário criar esses serviços, configurar as credenciais na hospedagem e testar a operação. Nenhum serviço foi criado, conectado ou publicado por este pacote.

## Configuração inicial do Supabase

1. Crie um projeto Supabase e guarde a URL e a chave pública publishable/anon. Não compartilhe nem inclua a chave `service_role` no navegador ou no repositório.
2. No SQL Editor do projeto, aplique, nesta ordem, `001_vertice_core.sql`, `002_secure_live_backend.sql`, `003_lock_organization_bootstrap.sql` e `004_six_star_operations.sql`.
3. Em Authentication, habilite o provedor Phone. O login operacional usa telefone confirmado e senha. Configure um serviço SMS se a operação também quiser códigos/recuperação por SMS.
4. Crie a primeira conta responsável (owner) em Authentication → Users, usando o telefone do administrador inicial e uma senha temporária forte. Anote o UUID da conta.
5. No SQL Editor, vincule essa conta à Six Star Mobilidade:

   ```sql
   with nova_operacao as (
     insert into public.vertice_organizations (name, created_by)
     values ('Six Star Mobilidade', 'UUID-DA-CONTA-OWNER'::uuid)
     returning id
   )
   insert into public.vertice_members (organization_id, user_id, role)
   select id, 'UUID-DA-CONTA-OWNER'::uuid, 'owner' from nova_operacao;
   ```

6. Publique a função `supabase/functions/vertice-create-user/index.ts` no mesmo projeto Supabase. Pela Supabase CLI, associe o projeto e execute `supabase functions deploy vertice-create-user`. A função usa a chave privilegiada somente no servidor; confira o segredo de serviço do projeto no ambiente seguro das Edge Functions. Nunca coloque essa chave em `config.js`.
7. Preencha `config.js` com `supabaseUrl` e `supabasePublishableKey`. Os campos vazios são intencionais até a configuração local do pacote.
8. Entre como owner no app. Cadastre **Wilson Santos** como motorista com o veículo **Tiggo 7**; depois ele aparecerá no seletor das corridas. Cadastre os demais usuários pelo painel e entregue senhas iniciais por canal privado.
9. Hospede em um domínio HTTPS e configure em Authentication → URL Configuration o endereço publicado. Restrinja origens/callbacks ao domínio usado pela operação.
10. Opcional: configure uma chave da Google Maps JavaScript API com restrição HTTP ao domínio para exibir o mapa geográfico. Os links individuais de Maps/Waze funcionam sem essa chave.

## Instalação PWA

- **Android:** abra o endereço HTTPS no navegador e use “Instalar app” ou “Adicionar à tela inicial”.
- **iPhone/iPad:** abra o endereço no Safari, toque em Compartilhar e escolha “Adicionar à Tela de Início”.

A PWA instala a interface nos dois sistemas, mas **não mantém o GPS funcionando com o aplicativo fechado**. O envio de localização por navegador exige permissão, conexão e app aberto/ativo; o sistema operacional pode suspender a página.

## Requisito de rastreamento com o app fechado

O requisito de GPS em segundo plano no Android e no iPhone ainda depende de uma versão nativa/híbrida, plugin de geolocalização em background, permissões e avisos de privacidade próprios de cada sistema, assinatura dos aplicativos e publicação/revisão nas lojas. O pacote atual não contém binários Android/iOS assinados nem essa integração nativa, portanto não deve ser considerado pronto para rastreamento com o app encerrado.

## Operação e privacidade

- Cada motorista compartilha apenas sua última posição; a tabela não mantém um histórico completo de trajetos.
- Localização de trabalhadores e dados de passageiros exigem aviso transparente, controles de acesso, retenção definida e revisão das bases legais aplicáveis.
- As chaves do Supabase e do Google Maps não devem ser enviadas no chat. Configure-as diretamente nos respectivos serviços/hospedagem.
- Não use o sistema com passageiros ou motoristas reais antes de configurar, testar acesso, políticas, notificações e GPS em cada aparelho.
