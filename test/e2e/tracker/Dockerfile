# opentracker, the tracker behind many large public trackers.
FROM alpine:3.22
RUN apk add --no-cache opentracker
EXPOSE 6969/tcp 6969/udp
# HTTP and UDP on 6969.
CMD ["opentracker", "-p", "6969", "-P", "6969"]
