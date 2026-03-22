import BasePage from "@/components/base";
import Image from "next/image";

export default function Home() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <BasePage server="ws://localhost:8080"/>
    </div>
  );
}
