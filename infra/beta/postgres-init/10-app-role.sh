#!/bin/sh
# Runs once, on the first start of an empty data volume. kd-api connects as kd_app, which owns only
# the kd database: it can run its own migrations but holds no superuser or cross-database rights.
# The password is read inside psql with \getenv, so it never appears on a command line.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_pw KD_DB_APP_PASSWORD
\if :{?app_pw}
\else
  \echo 'KD_DB_APP_PASSWORD is not set'
  \quit 3
\endif
CREATE ROLE kd_app LOGIN PASSWORD :'app_pw';
CREATE DATABASE kd OWNER kd_app;
REVOKE ALL ON DATABASE kd FROM PUBLIC;
SQL
