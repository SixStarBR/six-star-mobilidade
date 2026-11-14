# Six Star Mobilidade — Vértice

Pacote atualizado do app web/PWA da Six Star Mobilidade. Inclui o painel administrativo e do motorista, integração com o Supabase já configurado no `config.js` e a interface de cadastro de motoristas conectada à Edge Function `admin-create-user` já publicada.

## Publicar esta atualização pelo GitHub Desktop

1. Baixe e extraia este ZIP no computador.
2. Abra o repositório `six-star-mobilidade` no GitHub Desktop. Use **Repository → Show in Explorer** (Windows) ou **Show in Finder** (Mac) para abrir a pasta do repositório.
3. Copie o conteúdo extraído do ZIP para dentro da pasta do repositório e aceite substituir os arquivos existentes. Não apague nem substitua a pasta `.git`.
4. No GitHub Desktop, confira a lista de alterações. Escreva uma mensagem como `Integra cadastro de motoristas` e clique **Commit to main** (ou para a branch que estiver usando).
5. Clique **Push origin**. A Vercel deve iniciar uma nova publicação automaticamente.
6. Aguarde o status de publicação **Ready** na Vercel e abra o endereço do site. Atualize a página; se ainda mostrar a versão antiga, feche e reabra o navegador ou limpe os dados do site para atualizar o cache da PWA.

## Configuração e segurança

- `config.js` contém apenas a URL do projeto e a chave **publishable** do Supabase. Essa chave é destinada ao cliente e pode ficar no repositório; nunca adicione `service_role`, senha ou tokens nesse arquivo.
- A Edge Function `admin-create-user` já foi publicada separadamente no Supabase. Este pacote inclui o código-fonte correspondente para referência. **Não é necessário publicar a função novamente para esta atualização do painel.**
- As migrações `001` a `004` já foram aplicadas no projeto Supabase. **Não as execute novamente.**
- A função de cadastro só autoriza uma conta vinculada ao papel `owner`. O perfil criado para a nova pessoa é `driver`.
- O celular do motorista é usado como login no formato `DDD+número@sixstar.mobi`; a pessoa entra no app digitando o próprio número com DDD, sem precisar informar o e-mail técnico.
- A senha inicial deve ter pelo menos 8 caracteres. Entregue-a ao motorista por um canal privado; não a envie neste chat.

## Cadastrar o primeiro motorista

1. Entre no site com o login do responsável (`owner`).
2. No painel, escolha **Cadastrar motorista**.
3. Informe nome completo, celular com DDD, veículo associado e senha inicial; então clique **Criar acesso**.
4. Confirme que o sistema exibiu a mensagem de cadastro concluído. O motorista deverá entrar com o celular cadastrado e a senha inicial.
5. Para testar, use uma janela anônima ou outro aparelho e confirme que a conta abre a área do motorista, não a área administrativa.

Se ocorrer falha de vínculo ou de perfil, não tente cadastrar o mesmo celular novamente até conferir o resultado em **Edge Functions → Logs**; remova dos logs ou da conversa quaisquer dados sensíveis antes de compartilhar uma mensagem de erro.

## Limites conhecidos

- A PWA permite instalação em Android e iPhone via HTTPS, mas não garante transmissão de GPS com o app fechado ou suspenso, sobretudo no iPhone. Rastreamento contínuo em segundo plano exige uma versão nativa/híbrida.
- A chave do Google Maps permanece vazia. O mapa esquemático e os links de Maps/Waze funcionam sem ela; para mapa geográfico, configure uma chave própria restrita ao domínio no Google Cloud.
- Antes de usar dados reais, valide permissões, corridas, funcionamento do GPS com o app aberto e avisos de privacidade com a equipe.
