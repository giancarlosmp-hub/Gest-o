BEGIN TRANSACTION READ ONLY;
CREATE TABLE public.pr827_forbidden_write (id integer);
ROLLBACK;
