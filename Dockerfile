FROM ghcr.io/linuxserver/jackett:latest

# Copia sua versão modificada do JackettIO
COPY src/ /app/

# Ajusta permissões (LinuxServer roda como abc:abc)
RUN chown -R abc:abc /app
