"use client";

import React from "react";
import styles from "./page.module.css";

const Home = () => {
  const categories = {
    "Chat Basico": "basic-chat",
    "Agregar docuemntos": "file-search",
  };

  return (
    <main className={styles.main}>
      <div className={styles.title}>
        Agente Secundario de Integración Documental y Mejora de Respuestas en Telegram
      </div>
      <div className={styles.container}>
        {Object.entries(categories).map(([name, url]) => (
          <a key={name} className={styles.category} href={`/examples/${url}`}>
            {name}
          </a>
        ))}
      </div>
    </main>
  );
};

export default Home;
