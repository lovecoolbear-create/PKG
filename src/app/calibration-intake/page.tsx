import { getAllProductTypes } from "@/config/products";
import { CalibrationIntakeForm } from "@/components/calibration/CalibrationIntakeForm";

export default function CalibrationIntakePage() {
  const productTypes = getAllProductTypes();
  return (
    <main className="min-h-screen bg-brand-50 py-8">
      <CalibrationIntakeForm productTypes={productTypes} />
    </main>
  );
}
