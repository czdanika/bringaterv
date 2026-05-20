FROM nginx:alpine
COPY . /usr/share/nginx/html
RUN find /usr/share/nginx/html -type f -exec chmod 644 {} \;
RUN find /usr/share/nginx/html -type d -exec chmod 755 {} \;
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
