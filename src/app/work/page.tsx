import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import WorkbenchClient from "@/components/work/WorkbenchClient";

export default function WorkPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-brand-600" />
        </div>
      }
    >
      <WorkbenchClient />
    </Suspense>
  );
}
