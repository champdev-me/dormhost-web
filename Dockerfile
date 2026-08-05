# Static site. nginx serves it directly — there is nothing to build, so there is
# nothing to go wrong at build time.
FROM nginx:alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY *.html /usr/share/nginx/html/
COPY style.css /usr/share/nginx/html/

EXPOSE 80
