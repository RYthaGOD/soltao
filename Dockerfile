# soltao is static files. nginx serves them; Railway builds this remotely.
# No npm, no build step, nothing to install.
FROM nginx:1.27-alpine

# Railway injects PORT at runtime. The official nginx image runs envsubst over
# /etc/nginx/templates/*.template on boot, so the port lands in the config
# without a custom entrypoint.
ENV PORT=8080

COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template

WORKDIR /usr/share/nginx/html
RUN rm -f ./*
COPY index.html styles.css app.js pairs.json ./
COPY favicon.svg logo.png og.png og.html robots.txt sitemap.xml ./
COPY stake/index.html stake/stake.css stake/stake.js stake/stake.js.LEGAL.txt ./stake/

EXPOSE 8080
