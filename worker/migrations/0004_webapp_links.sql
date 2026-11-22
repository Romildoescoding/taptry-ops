-- Links the inbox scripts reported about themselves don't work for new deployments
-- (Apps Script getUrl()). Links are now pasted on the System tab instead.
DELETE FROM config WHERE key LIKE 'gas_url_%';
