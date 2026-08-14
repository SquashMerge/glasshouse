-- Retained internal direct writes need a durable identity without reopening
-- mutable or nullable published Dataset identifiers.
CREATE OR REPLACE FUNCTION assign_missing_dataset_slug()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.slug IS NULL THEN
        NEW.slug := 'dataset-' || replace(NEW.id::text, '-', '');
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS datasets_assign_missing_slug ON datasets;
CREATE TRIGGER datasets_assign_missing_slug
BEFORE INSERT ON datasets
FOR EACH ROW EXECUTE FUNCTION assign_missing_dataset_slug();
