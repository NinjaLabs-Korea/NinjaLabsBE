-- Each worker claim gets a fresh identity. PROCESSING alone cannot distinguish
-- a delayed attempt from the worker that reclaimed the same job.
ALTER TABLE nft_job ADD COLUMN claim_token UUID;
