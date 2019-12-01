#!/usr/bin/env bash

openssl genrsa -out localhost.key 2048
openssl req -new -x509 -key localhost.key -out localhost.cert -days 3650 -subj /CN=localhost
